// Mirrors an addon's blob store (~/.cyberlife/addon-data/<id>/) into an
// S3-compatible bucket (Cloudflare R2). Credentials arrive with each start
// request and live only for the duration of the job — the host never
// persists them. Upload-only: files deleted locally stay in the bucket.
package api

import (
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kalor62/cyberlife/internal/addons"
	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/paths"
)

type addonBackupConfig struct {
	Endpoint        string `json:"endpoint"`
	Bucket          string `json:"bucket"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	Prefix          string `json:"prefix,omitempty"`
}

type addonBackupRequest struct {
	Addon  string            `json:"addon"`
	Action string            `json:"action"`
	Config addonBackupConfig `json:"config"`
	// Job separates concurrent backups of one addon (e.g. one per company,
	// each into its own bucket); Keys limits the upload to those blob-store
	// paths instead of the whole directory
	Job  string   `json:"job,omitempty"`
	Keys []string `json:"keys,omitempty"`
}

type backupObject struct {
	ETag string `json:"etag"`
	Size int64  `json:"size"`
}

type backupJob struct {
	mu         sync.Mutex
	running    bool
	startedAt  time.Time
	finishedAt time.Time
	checked    int
	uploaded   int
	skipped    int
	failed     int
	sentBytes  int64
	lastError  string
	objects    map[string]backupObject
}

func (j *backupJob) snapshot(includeObjects bool) map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := map[string]any{
		"running":   j.running,
		"checked":   j.checked,
		"uploaded":  j.uploaded,
		"skipped":   j.skipped,
		"failed":    j.failed,
		"sentBytes": j.sentBytes,
		"lastError": j.lastError,
	}
	if !j.startedAt.IsZero() {
		out["startedAt"] = j.startedAt.Format(time.RFC3339)
	}
	if !j.finishedAt.IsZero() {
		out["finishedAt"] = j.finishedAt.Format(time.RFC3339)
	}
	if includeObjects && !j.running && j.objects != nil {
		out["objects"] = j.objects
	}
	return out
}

func (c addonBackupConfig) validate() (*url.URL, error) {
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("endpoint must be an https:// URL (e.g. https://<account>.r2.cloudflarestorage.com)")
	}
	if c.Bucket == "" || strings.ContainsAny(c.Bucket, "/ ") {
		return nil, fmt.Errorf("bucket name is required (no slashes)")
	}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return nil, fmt.Errorf("accessKeyId and secretAccessKey are required")
	}
	return u, nil
}

func (c addonBackupConfig) keyPrefix() string {
	p := strings.Trim(c.Prefix, "/")
	if p == "" {
		return ""
	}
	return p + "/"
}

func (s *Server) backupJobFor(addonID string) *backupJob {
	s.backupsMu.Lock()
	defer s.backupsMu.Unlock()
	if s.backups == nil {
		s.backups = map[string]*backupJob{}
	}
	job, ok := s.backups[addonID]
	if !ok {
		job = &backupJob{}
		s.backups[addonID] = job
	}
	return job
}

func (s *Server) handleAddonBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonBackupRequest
	if !decodeBody(w, r, &req) {
		return
	}
	addon, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", req.Addon))
		return
	}
	jobKey := addon.ID
	if req.Job != "" {
		jobKey += "|" + req.Job
	}
	job := s.backupJobFor(jobKey)

	switch req.Action {
	case "status":
		writeJSON(w, http.StatusOK, job.snapshot(true))
	case "test":
		endpoint, err := req.Config.validate()
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		client := &s3Client{endpoint: endpoint, cfg: req.Config, http: &http.Client{Timeout: 30 * time.Second}}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		remote, err := client.list(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, fmt.Errorf("bucket check failed: %w", err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "remoteObjects": len(remote)})
	case "start", "":
		endpoint, err := req.Config.validate()
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		root, err := paths.AddonData()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		job.mu.Lock()
		if job.running {
			job.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"started": false, "running": true})
			return
		}
		job.running = true
		job.startedAt = time.Now()
		job.finishedAt = time.Time{}
		job.checked, job.uploaded, job.skipped, job.failed = 0, 0, 0, 0
		job.sentBytes = 0
		job.lastError = ""
		job.mu.Unlock()
		go runBackup(job, jobKey, endpoint, req.Config, filepath.Join(root, addon.ID), req.Keys)
		writeJSON(w, http.StatusOK, map[string]any{"started": true, "running": true})
	default:
		writeErr(w, http.StatusBadRequest, fmt.Errorf("unknown action %q (start|status|test)", req.Action))
	}
}

func localBackupFiles(root string, keys []string) (map[string]int64, error) {
	out := map[string]int64{}
	if keys != nil {
		for _, key := range keys {
			rel, ok := cleanRelPath(key)
			if !ok {
				return nil, fmt.Errorf("invalid key %q", key)
			}
			info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
			if err != nil || info.IsDir() {
				logging.Warn("backup: listed key missing locally", "path", rel, "error", err)
				continue
			}
			out[rel] = info.Size()
		}
		return out, nil
	}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = info.Size()
		return nil
	})
	if os.IsNotExist(err) {
		return map[string]int64{}, nil
	}
	return out, err
}

func fileMD5(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() {
		if err := f.Close(); err != nil {
			logging.Debug("backup: file close failed", "path", path, "error", err)
		}
	}()
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func runBackup(job *backupJob, addonID string, endpoint *url.URL, cfg addonBackupConfig, root string, keys []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	client := &s3Client{endpoint: endpoint, cfg: cfg, http: &http.Client{Timeout: 2 * time.Minute}}

	finish := func(errMsg string) {
		job.mu.Lock()
		job.running = false
		job.finishedAt = time.Now()
		if errMsg != "" {
			job.lastError = errMsg
		}
		uploaded, failed := job.uploaded, job.failed
		job.mu.Unlock()
		logging.Info("addon backup finished", "addon", addonID, "uploaded", uploaded, "failed", failed, "error", errMsg)
	}

	local, err := localBackupFiles(root, keys)
	if err != nil {
		finish(fmt.Sprintf("local scan failed: %v", err))
		return
	}
	remote, err := client.list(ctx)
	if err != nil {
		finish(fmt.Sprintf("bucket listing failed: %v", err))
		return
	}
	logging.Info("addon backup started", "addon", addonID, "localFiles", len(local), "remoteObjects", len(remote))

	rels := make([]string, 0, len(local))
	for rel := range local {
		rels = append(rels, rel)
	}
	sort.Strings(rels)

	objects := map[string]backupObject{}
	var firstErr string
	for _, rel := range rels {
		size := local[rel]
		full := filepath.Join(root, filepath.FromSlash(rel))
		sum, err := fileMD5(full)
		if err != nil {
			logging.Warn("backup: md5 failed", "addon", addonID, "path", rel, "error", err)
			job.mu.Lock()
			job.failed++
			job.checked++
			job.mu.Unlock()
			continue
		}
		have, exists := remote[rel]
		// A single-part PUT makes the ETag the MD5 of the content; a
		// multipart ETag (with a "-") cannot be recomputed, so same size
		// counts as already backed up
		upToDate := exists && (have.ETag == sum || (strings.Contains(have.ETag, "-") && have.Size == size))
		if upToDate {
			objects[rel] = backupObject{ETag: have.ETag, Size: have.Size}
			job.mu.Lock()
			job.skipped++
			job.checked++
			job.mu.Unlock()
			continue
		}
		if err := client.put(ctx, rel, full); err != nil {
			logging.Warn("backup: upload failed", "addon", addonID, "path", rel, "error", err)
			if firstErr == "" {
				firstErr = fmt.Sprintf("%s: %v", rel, err)
			}
			job.mu.Lock()
			job.failed++
			job.checked++
			job.mu.Unlock()
			continue
		}
		objects[rel] = backupObject{ETag: sum, Size: size}
		job.mu.Lock()
		job.uploaded++
		job.checked++
		job.sentBytes += size
		job.mu.Unlock()
	}

	job.mu.Lock()
	job.objects = objects
	job.mu.Unlock()
	finish(firstErr)
}

// ---- minimal S3 client (list + put) with SigV4 signing ----

type s3Client struct {
	endpoint *url.URL
	cfg      addonBackupConfig
	http     *http.Client
}

type listBucketResult struct {
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
	Contents              []struct {
		Key  string `xml:"Key"`
		ETag string `xml:"ETag"`
		Size int64  `xml:"Size"`
	} `xml:"Contents"`
}

// list returns bucket objects under the configured prefix, keyed by their
// path relative to that prefix
func (c *s3Client) list(ctx context.Context) (map[string]backupObject, error) {
	prefix := c.cfg.keyPrefix()
	out := map[string]backupObject{}
	token := ""
	for {
		query := url.Values{"list-type": {"2"}}
		if prefix != "" {
			query.Set("prefix", prefix)
		}
		if token != "" {
			query.Set("continuation-token", token)
		}
		body, err := c.do(ctx, http.MethodGet, "", query, "")
		if err != nil {
			return nil, err
		}
		var page listBucketResult
		if err := xml.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("listing response parse: %w", err)
		}
		for _, obj := range page.Contents {
			rel := strings.TrimPrefix(obj.Key, prefix)
			out[rel] = backupObject{ETag: strings.Trim(obj.ETag, `"`), Size: obj.Size}
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return out, nil
		}
		token = page.NextContinuationToken
	}
}

func (c *s3Client) put(ctx context.Context, rel, localPath string) error {
	_, err := c.do(ctx, http.MethodPut, c.cfg.keyPrefix()+rel, nil, localPath)
	return err
}

const emptyPayloadSHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func (c *s3Client) do(ctx context.Context, method, key string, query url.Values, bodyPath string) ([]byte, error) {
	target := *c.endpoint
	target.Path = "/" + c.cfg.Bucket
	if key != "" {
		target.Path += "/" + key
	}
	if query != nil {
		target.RawQuery = query.Encode()
	}

	payloadHash := emptyPayloadSHA
	var body io.Reader
	var size int64
	if bodyPath != "" {
		f, err := os.Open(bodyPath)
		if err != nil {
			return nil, err
		}
		defer func() {
			if err := f.Close(); err != nil {
				logging.Debug("backup: body close failed", "path", bodyPath, "error", err)
			}
		}()
		h := sha256.New()
		n, err := io.Copy(h, f)
		if err != nil {
			return nil, err
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		payloadHash = hex.EncodeToString(h.Sum(nil))
		body = f
		size = n
	}

	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, err
	}
	if bodyPath != "" {
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	signV4(req, c.cfg.AccessKeyID, c.cfg.SecretAccessKey, payloadHash, time.Now().UTC())

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := res.Body.Close(); err != nil {
			logging.Debug("backup: response close failed", "error", err)
		}
	}()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("%s %s: %s: %s", method, target.Path, res.Status, condenseXMLError(data))
	}
	return data, nil
}

// condenseXMLError extracts the human part of an S3 error response
func condenseXMLError(body []byte) string {
	var e struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if xml.Unmarshal(body, &e) == nil && e.Code != "" {
		return e.Code + ": " + e.Message
	}
	s := strings.TrimSpace(string(body))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func uriEncode(s string, keepSlash bool) string {
	var b strings.Builder
	for _, ch := range []byte(s) {
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9',
			ch == '-', ch == '.', ch == '_', ch == '~':
			b.WriteByte(ch)
		case ch == '/' && keepSlash:
			b.WriteByte(ch)
		default:
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// signV4 signs an S3 request (AWS Signature Version 4; R2 uses region
// "auto") with host, x-amz-date and x-amz-content-sha256 as signed headers
func signV4(req *http.Request, accessKey, secret, payloadHash string, now time.Time) {
	const region, service = "auto", "s3"
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)

	var queryPairs []string
	for k, vs := range req.URL.Query() {
		for _, v := range vs {
			queryPairs = append(queryPairs, uriEncode(k, false)+"="+uriEncode(v, false))
		}
	}
	sort.Strings(queryPairs)

	canonicalHeaders := "host:" + req.URL.Host + "\n" +
		"x-amz-content-sha256:" + payloadHash + "\n" +
		"x-amz-date:" + amzDate + "\n"
	const signedHeaders = "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{
		req.Method,
		uriEncode(req.URL.Path, true),
		strings.Join(queryPairs, "&"),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := date + "/" + region + "/" + service + "/aws4_request"
	digest := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hex.EncodeToString(digest[:]),
	}, "\n")

	signingKey := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256(
		[]byte("AWS4"+secret), []byte(date)), []byte(region)), []byte(service)), []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
}
