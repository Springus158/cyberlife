// Addon platform bridges: an outbound HTTP proxy for integration addons
// (the webview enforces CORS, which third-party APIs like KSeF don't send)
// and an MCP tool bridge that routes agent tool calls into addon frontend
// code and waits for the result.
package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kalor62/cyberlife/internal/addons"
	"github.com/kalor62/cyberlife/internal/logging"
)

// ---- outbound HTTP proxy ----

const (
	maxProxyResponse = 20 << 20
	proxyTimeout     = 45 * time.Second
)

// allowedProxyTarget gates every hop, not just the first: a redirect to a
// host outside the manifest allowlist (or to plain http) is where an
// allowlisted third party would otherwise smuggle the app into the local
// network. Name-based checks alone cannot do that — see proxyClient.
func allowedProxyTarget(a addons.Addon, u *url.URL) error {
	if u.Scheme != "https" {
		return fmt.Errorf("only https is allowed, got %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("url has no host")
	}
	if net.ParseIP(host) != nil || strings.EqualFold(host, "localhost") {
		return errors.New("IP and localhost targets are not allowed")
	}
	if !a.HostAllowed(host) {
		return fmt.Errorf("host %q is not in the addon's hosts allowlist", host)
	}
	return nil
}

// proxyClient resolves before it connects and refuses any name that lands on
// a private address, so an allowlisted hostname pointing at 127.0.0.1 (or a
// DNS rebind mid-request) cannot reach the app's own API or the LAN
func proxyClient(a addons.Addon) *http.Client {
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	return &http.Client{
		Timeout: proxyTimeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, _, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
				if err != nil {
					return nil, err
				}
				for _, ip := range ips {
					if !publicIP(ip.IP) {
						return nil, fmt.Errorf("%w: %s", errPrivateAddress, ip.IP)
					}
				}
				return dialer.DialContext(ctx, network, addr)
			},
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many redirects")
			}
			return allowedProxyTarget(a, req.URL)
		},
	}
}

type addonHTTPRequest struct {
	Addon   string            `json:"addon"`
	Method  string            `json:"method,omitempty"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

func (s *Server) handleAddonHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonHTTPRequest
	if !decodeBody(w, r, &req) {
		return
	}
	addon, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", req.Addon))
		return
	}
	u, err := url.Parse(req.URL)
	if err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("url must be absolute https"))
		return
	}
	if err := allowedProxyTarget(addon, u); err != nil {
		writeErr(w, http.StatusForbidden, err)
		return
	}

	// The handler's own write deadline is shorter than an upstream call may
	// take, and a response written after it is lost
	if rc := http.NewResponseController(w); rc != nil {
		if err := rc.SetWriteDeadline(time.Now().Add(proxyTimeout + 15*time.Second)); err != nil {
			logging.Debug("addon proxy: write deadline not settable", "error", err)
		}
	}

	method := strings.ToUpper(req.Method)
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	out, err := http.NewRequestWithContext(r.Context(), method, req.URL, body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	for k, v := range req.Headers {
		out.Header.Set(k, v)
	}
	resp, err := proxyClient(addon).Do(out)
	if err != nil {
		logging.Warn("addon http proxy request failed", "addon", req.Addon, "host", u.Hostname(), "error", err)
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	defer resp.Body.Close()
	// One byte over the cap distinguishes "exactly at the limit" from
	// "truncated", so a cut-off body is never returned as if it were whole
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxProxyResponse+1))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	if len(data) > maxProxyResponse {
		writeErr(w, http.StatusBadGateway, fmt.Errorf("response exceeds %d bytes", maxProxyResponse))
		return
	}
	result := map[string]any{"status": resp.StatusCode, "headers": map[string][]string(resp.Header)}
	if utf8.Valid(data) {
		result["body"] = string(data)
	} else {
		result["body"] = base64.StdEncoding.EncodeToString(data)
		result["bodyBase64"] = true
	}
	writeJSON(w, http.StatusOK, result)
}

// ---- PDF text extraction ----

const maxPdfBytes = 15 << 20

type addonPdfTextRequest struct {
	Addon      string `json:"addon"`
	DataBase64 string `json:"dataBase64"`
}

// handleAddonPdfText extracts text (layout-preserving) from a PDF for an
// enabled addon. The webview cannot read PDFs, so this shells out to
// poppler's pdftotext — reported as an optional dependency when missing.
func (s *Server) handleAddonPdfText(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonPdfTextRequest
	if !decodeBody(w, r, &req) {
		return
	}
	addon, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", req.Addon))
		return
	}
	data, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("dataBase64 is not valid base64"))
		return
	}
	if len(data) == 0 || len(data) > maxPdfBytes {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("PDF must be 1 byte to %d MB", maxPdfBytes>>20))
		return
	}
	bin, err := exec.LookPath("pdftotext")
	if err != nil {
		writeErr(w, http.StatusNotImplemented, fmt.Errorf("pdftotext not installed — install poppler (brew install poppler / apt install poppler-utils)"))
		return
	}
	tmp, err := os.CreateTemp("", "addon-*.pdf")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	defer func() {
		if err := os.Remove(tmp.Name()); err != nil {
			logging.Debug("pdftext temp remove failed", "error", err)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := tmp.Close(); err != nil {
		logging.Debug("pdftext temp close failed", "error", err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-layout", tmp.Name(), "-").Output()
	if err != nil {
		logging.Warn("pdftotext failed", "addon", req.Addon, "error", err)
		writeErr(w, http.StatusUnprocessableEntity, fmt.Errorf("pdftotext failed: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": string(out)})
}

// ---- agent tool bridge ----

const (
	addonToolTimeout = 45 * time.Second
	maxAddonCalls    = 64
)

type addonToolResult struct {
	result json.RawMessage
	err    string
}

// pendingAddonCall records which addon a bridged call belongs to, so another
// addon in the same webview cannot answer on its behalf
type pendingAddonCall struct {
	addon string
	ch    chan addonToolResult
}

func (s *Server) addonToolGroups() []toolGroup {
	var out []toolGroup
	static := s.staticGroupIDs()
	for _, a := range addons.LoadAll(s.manager.GetAddonsEnabled()) {
		if len(a.AgentTools) == 0 || a.Error != "" || static[a.ID] {
			continue
		}
		addon := a
		out = append(out, toolGroup{
			id:    addon.ID,
			tools: func() []mcpTool { return addonMcpTools(addon) },
			call: func(name string, args json.RawMessage) (any, error) {
				return s.callAddonAgentTool(addon, name, args)
			},
		})
	}
	return out
}

func addonMcpTools(a addons.Addon) []mcpTool {
	out := make([]mcpTool, 0, len(a.AgentTools))
	for _, t := range a.AgentTools {
		schema := map[string]any{"type": "object"}
		if len(t.Schema) > 0 {
			if err := json.Unmarshal(t.Schema, &schema); err != nil {
				logging.Warn("addon tool schema invalid, using empty object", "addon", a.ID, "tool", t.Name, "error", err)
				schema = map[string]any{"type": "object"}
			}
		}
		out = append(out, mcpTool{
			Name:        a.ID + "_" + t.Name,
			Description: fmt.Sprintf("[%s addon] %s", a.Name, t.Description),
			InputSchema: schema,
		})
	}
	return out
}

func (s *Server) callAddonAgentTool(a addons.Addon, fullName string, args json.RawMessage) (any, error) {
	if s.emitPayload == nil {
		return nil, fmt.Errorf("addon tools unavailable in this build")
	}
	name := strings.TrimPrefix(fullName, a.ID+"_")
	declared := false
	for _, t := range a.AgentTools {
		if t.Name == name {
			declared = true
			break
		}
	}
	if !declared {
		return nil, fmt.Errorf("unknown tool %q", fullName)
	}

	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, fmt.Errorf("call id generation failed: %w", err)
	}
	callID := hex.EncodeToString(nonce[:])
	ch := make(chan addonToolResult, 1)

	s.addonCallsMu.Lock()
	if len(s.addonCalls) >= maxAddonCalls {
		s.addonCallsMu.Unlock()
		return nil, fmt.Errorf("too many addon tool calls in flight (%d)", maxAddonCalls)
	}
	if s.addonCalls == nil {
		s.addonCalls = make(map[string]pendingAddonCall)
	}
	s.addonCalls[callID] = pendingAddonCall{addon: a.ID, ch: ch}
	s.addonCallsMu.Unlock()
	defer func() {
		s.addonCallsMu.Lock()
		delete(s.addonCalls, callID)
		s.addonCallsMu.Unlock()
	}()

	var argsVal any
	if len(args) > 0 {
		if err := json.Unmarshal(args, &argsVal); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	s.emitPayload("addon-agent-tool", map[string]any{
		"callId": callID, "addon": a.ID, "tool": name, "args": argsVal,
	})

	select {
	case res := <-ch:
		if res.err != "" {
			return nil, fmt.Errorf("%s", res.err)
		}
		var v any
		if len(res.result) > 0 {
			if err := json.Unmarshal(res.result, &v); err != nil {
				return nil, fmt.Errorf("addon returned invalid JSON: %w", err)
			}
		}
		return v, nil
	case <-time.After(addonToolTimeout):
		return nil, fmt.Errorf("addon tool %s timed out after %s — the addon did not answer (app window running? addon enabled?)", fullName, addonToolTimeout)
	}
}

type addonToolResultRequest struct {
	CallID string          `json:"callId"`
	Addon  string          `json:"addon"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// handleAddonToolResult receives the webview's answer to one bridged call
func (s *Server) handleAddonToolResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonToolResultRequest
	if !decodeBody(w, r, &req) {
		return
	}
	s.addonCallsMu.Lock()
	pending, ok := s.addonCalls[req.CallID]
	if ok && pending.addon == req.Addon {
		delete(s.addonCalls, req.CallID)
	}
	s.addonCallsMu.Unlock()
	if !ok {
		writeErr(w, http.StatusNotFound, fmt.Errorf("no pending call %q (timed out?)", req.CallID))
		return
	}
	if pending.addon != req.Addon {
		logging.Warn("addon tool result rejected: addon mismatch", "callId", req.CallID, "claimed", req.Addon, "owner", pending.addon)
		writeErr(w, http.StatusForbidden, fmt.Errorf("call %q does not belong to addon %q", req.CallID, req.Addon))
		return
	}
	pending.ch <- addonToolResult{result: req.Result, err: req.Error}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
