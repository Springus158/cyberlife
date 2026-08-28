// System notifications raised by addons through cl.notify(). The manifest
// "notify" permission is enforced in the addon host, which is the only caller;
// this endpoint just validates the payload and forwards it to the platform
// notifier used by automations.
package api

import (
	"fmt"
	"net/http"
	"strings"
)

const (
	maxNotifyTitleLen   = 120
	maxNotifyMessageLen = 500
)

type notifyRequest struct {
	Title   string `json:"title"`
	Message string `json:"message"`
}

func (s *Server) handleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req notifyRequest
	if !decodeBody(w, r, &req) {
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("title is required"))
		return
	}
	if s.systemNotify == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("notifications are unavailable"))
		return
	}
	if err := s.systemNotify(trunc(title, maxNotifyTitleLen), trunc(strings.TrimSpace(req.Message), maxNotifyMessageLen)); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func trunc(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}
