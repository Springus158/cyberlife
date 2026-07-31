// Addon platform bridges: an outbound HTTP proxy for integration addons
// (the webview enforces CORS, which third-party APIs like KSeF don't send)
// and an MCP tool bridge that routes agent tool calls into addon frontend
// code and waits for the result.
package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kalor62/cyberlife/internal/addons"
	"github.com/kalor62/cyberlife/internal/logging"
)

// ---- outbound HTTP proxy ----

const (
	maxProxyResponse = 20 << 20
	proxyTimeout     = 90 * time.Second
)

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
	if err != nil || u.Scheme != "https" || u.Hostname() == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("url must be absolute https"))
		return
	}
	// The manifest names public API hosts; loopback and raw IPs stay out so
	// an addon cannot reach the local network with the app's privileges
	host := u.Hostname()
	if net.ParseIP(host) != nil || strings.EqualFold(host, "localhost") {
		writeErr(w, http.StatusForbidden, fmt.Errorf("IP and localhost targets are not allowed"))
		return
	}
	if !addon.HostAllowed(host) {
		writeErr(w, http.StatusForbidden, fmt.Errorf("host %q is not in the addon's hosts allowlist", host))
		return
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
	client := &http.Client{Timeout: proxyTimeout}
	resp, err := client.Do(out)
	if err != nil {
		logging.Warn("addon http proxy request failed", "addon", req.Addon, "host", host, "error", err)
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxProxyResponse))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	headers := make(map[string]string, len(resp.Header))
	for k := range resp.Header {
		headers[k] = resp.Header.Get(k)
	}
	result := map[string]any{"status": resp.StatusCode, "headers": headers}
	if utf8.Valid(data) {
		result["body"] = string(data)
	} else {
		result["body"] = base64.StdEncoding.EncodeToString(data)
		result["bodyBase64"] = true
	}
	writeJSON(w, http.StatusOK, result)
}

// ---- agent tool bridge ----

const addonToolTimeout = 120 * time.Second

type addonToolResult struct {
	result json.RawMessage
	err    string
}

func (s *Server) addonToolGroups() []toolGroup {
	var out []toolGroup
	for _, a := range addons.LoadAll(s.manager.GetAddonsEnabled()) {
		if len(a.AgentTools) == 0 || a.Error != "" || staticGroupIDs[a.ID] {
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

	s.addonCallsMu.Lock()
	s.addonCallSeq++
	callID := fmt.Sprintf("%s-%d", a.ID, s.addonCallSeq)
	ch := make(chan addonToolResult, 1)
	if s.addonCalls == nil {
		s.addonCalls = make(map[string]chan addonToolResult)
	}
	s.addonCalls[callID] = ch
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
	ch := s.addonCalls[req.CallID]
	delete(s.addonCalls, req.CallID)
	s.addonCallsMu.Unlock()
	if ch == nil {
		writeErr(w, http.StatusNotFound, fmt.Errorf("no pending call %q (timed out?)", req.CallID))
		return
	}
	ch <- addonToolResult{result: req.Result, err: req.Error}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
