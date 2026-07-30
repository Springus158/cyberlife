package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
)

// Remote images in mail bodies cannot be loaded directly: the webview CSP does
// not allow arbitrary hosts, and a direct load would hand the sender the
// reader's IP alongside whatever cookies the webview holds. This proxy fetches
// them server-side with no cookies, no referrer and no redirect chain into the
// private network, so a tracking pixel learns nothing beyond "someone fetched".

const (
	mailImageMaxBytes = 12 << 20
	mailImageTimeout  = 15 * time.Second
)

var errPrivateAddress = errors.New("refusing to fetch a private address")

func mailImageClient() *http.Client {
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	return &http.Client{
		Timeout: mailImageTimeout,
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
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("refusing redirect to %s", req.URL.Scheme)
			}
			return nil
		},
	}
}

func publicIP(ip net.IP) bool {
	return !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsUnspecified() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() &&
		!ip.IsInterfaceLocalMulticast() && !ip.IsMulticast()
}

func (s *Server) handleMailImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	target, err := url.Parse(r.URL.Query().Get("u"))
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		http.Error(w, "bad image url", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(w, "bad image url", http.StatusBadRequest)
		return
	}
	req.Header.Set("Accept", "image/*")
	req.Header.Set("User-Agent", "CyberLife-Mail/1.0")

	resp, err := mailImageClient().Do(req)
	if err != nil {
		logging.Debug("mail image fetch failed", "host", target.Host, "error", err)
		http.Error(w, "image unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, "image unavailable", http.StatusBadGateway)
		return
	}
	mime := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(mime, "image/") {
		logging.Debug("mail image rejected: not an image", "host", target.Host, "mime", mime)
		http.Error(w, "not an image", http.StatusUnsupportedMediaType)
		return
	}

	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if _, err := io.Copy(w, io.LimitReader(resp.Body, mailImageMaxBytes)); err != nil {
		logging.Debug("mail image stream failed", "host", target.Host, "error", err)
	}
}
