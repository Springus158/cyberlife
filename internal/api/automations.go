package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/kalor62/cyberlife/internal/state"
)

// Automation tools: agents create and manage trigger → action rules and can
// run them on demand. Execution itself lives in the app layer (AutoRun hook).

func (s *Server) autoEnabled() bool { return s.groupEnabled("auto") }

type autoRequest struct {
	RuleID  string                `json:"ruleId,omitempty"`
	Rule    *state.AutomationRule `json:"rule,omitempty"`
	Enabled *bool                 `json:"enabled,omitempty"`
	Limit   int                   `json:"limit,omitempty"`
	Project string                `json:"project,omitempty"`
}

func (s *Server) opAutoRules(projectRef string) (any, error) {
	rules := s.manager.GetAutomationRules()
	if projectRef != "" {
		project, ok := s.manager.ResolveProject(projectRef)
		if !ok {
			return nil, fmt.Errorf("project %q not found", projectRef)
		}
		filtered := rules[:0]
		for _, r := range rules {
			if r.ProjectID == "" || r.ProjectID == project.ID {
				filtered = append(filtered, r)
			}
		}
		rules = filtered
	}
	return map[string]any{"rules": rules}, nil
}

func (s *Server) opAutoSaveRule(req autoRequest) (any, error) {
	if req.Rule == nil {
		return nil, fmt.Errorf("rule is required")
	}
	rule := *req.Rule
	if rule.ProjectID != "" {
		project, ok := s.manager.ResolveProject(rule.ProjectID)
		if !ok {
			return nil, fmt.Errorf("project %q not found", rule.ProjectID)
		}
		rule.ProjectID = project.ID
	}
	if rule.ID == "" && req.Enabled == nil {
		rule.Enabled = true
	}
	saved, err := s.manager.SaveAutomationRule(rule)
	if err != nil {
		return nil, err
	}
	s.notifyAuto()
	return map[string]any{"rule": saved}, nil
}

func (s *Server) opAutoDeleteRule(req autoRequest) (any, error) {
	if req.RuleID == "" {
		return nil, fmt.Errorf("ruleId is required")
	}
	if err := s.manager.DeleteAutomationRule(req.RuleID); err != nil {
		return nil, err
	}
	s.notifyAuto()
	return map[string]any{"ok": true}, nil
}

func (s *Server) opAutoSetEnabled(req autoRequest) (any, error) {
	if req.RuleID == "" || req.Enabled == nil {
		return nil, fmt.Errorf("ruleId and enabled are required")
	}
	if err := s.manager.SetAutomationRuleEnabled(req.RuleID, *req.Enabled); err != nil {
		return nil, err
	}
	s.notifyAuto()
	return map[string]any{"ok": true}, nil
}

func (s *Server) opAutoRun(req autoRequest) (any, error) {
	if s.autoRun == nil {
		return nil, fmt.Errorf("automation engine unavailable")
	}
	if req.RuleID == "" {
		return nil, fmt.Errorf("ruleId is required")
	}
	run, err := s.autoRun(req.RuleID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"run": run}, nil
}

func (s *Server) opAutoRuns(req autoRequest) (any, error) {
	limit := req.Limit
	if limit <= 0 {
		limit = 30
	}
	return map[string]any{"runs": s.manager.GetAutomationRuns(limit)}, nil
}

func (s *Server) notifyAuto() {
	if s.onAutoChange != nil {
		s.onAutoChange()
	}
}

// handleWebhook fires webhook-triggered rules: POST /api/hooks/<slug>.
// The server binds to localhost only, so callers are local processes
// (scripts, agents, git hooks) or anything the user tunnels in.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !s.autoEnabled() {
		writeErr(w, http.StatusForbidden, fmt.Errorf("automations skill is disabled in Cyber Life settings"))
		return
	}
	if s.webhookFire == nil {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("automation engine unavailable"))
		return
	}
	slug := strings.TrimPrefix(r.URL.Path, "/api/hooks/")
	if slug == "" || strings.Contains(slug, "/") {
		writeErr(w, http.StatusNotFound, fmt.Errorf("unknown hook"))
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
	if err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("read body: %w", err))
		return
	}
	matched := s.webhookFire(slug, body)
	if matched == 0 {
		writeErr(w, http.StatusNotFound, fmt.Errorf("no enabled rule listens on hook %q", slug))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fired": matched})
}

// ---- REST ----

func (s *Server) handleAutoRules(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "auto") {
		return
	}
	if r.Method == http.MethodGet {
		out, err := s.opAutoRules(r.URL.Query().Get("project"))
		if err != nil {
			writeErr(w, http.StatusNotFound, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	var req autoRequest
	if !decodeBody(w, r, &req) {
		return
	}
	out, err := s.opAutoSaveRule(req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAutoRuns(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "auto") {
		return
	}
	out, err := s.opAutoRuns(autoRequest{})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- MCP tools ----

var ruleSchema = map[string]any{
	"type":        "object",
	"description": "The rule. trigger.type: task-status (needs column) | cron (everyMinutes or dailyAt HH:MM) | mail (optional account/fromContains/subjectContains) | manual. Each action has a type: run-agent {runner?, prompt, workDir?} | move-task {column} | comment {text} | notify {title?, message} | send-mail {account?, to, subject, body}. Text fields accept placeholders like {{task.title}}, {{project.name}}, {{column}}, {{mail.from}}, {{mail.subject}}.",
	"properties": map[string]any{
		"id":        map[string]any{"type": "string", "description": "Omit to create; set to update"},
		"name":      map[string]any{"type": "string"},
		"projectId": map[string]any{"type": "string", "description": "Project name/id/path; omit for a global rule"},
		"enabled":   map[string]any{"type": "boolean"},
		"trigger":   map[string]any{"type": "object"},
		"actions":   map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
	},
	"required": []string{"name", "trigger", "actions"},
}

func (s *Server) autoTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "auto_list_rules",
			Description: "List automation rules (trigger → actions). Optionally filter to one project (includes global rules).",
			InputSchema: objSchema(nil, map[string]any{"project": projectProp}),
		},
		{
			Name:        "auto_save_rule",
			Description: "Create or update an automation rule. New rules are enabled unless enabled=false.",
			InputSchema: objSchema([]string{"rule"}, map[string]any{"rule": ruleSchema}),
		},
		{
			Name:        "auto_delete_rule",
			Description: "Delete an automation rule by id",
			InputSchema: objSchema([]string{"ruleId"}, map[string]any{"ruleId": map[string]any{"type": "string"}}),
		},
		{
			Name:        "auto_set_enabled",
			Description: "Enable or disable a rule without deleting it",
			InputSchema: objSchema([]string{"ruleId", "enabled"}, map[string]any{
				"ruleId":  map[string]any{"type": "string"},
				"enabled": map[string]any{"type": "boolean"},
			}),
		},
		{
			Name:        "auto_run_rule",
			Description: "Execute a rule immediately and return the run record",
			InputSchema: objSchema([]string{"ruleId"}, map[string]any{"ruleId": map[string]any{"type": "string"}}),
		},
		{
			Name:        "auto_list_runs",
			Description: "Recent automation runs (newest first) with status and linked session/task/mail ids",
			InputSchema: objSchema(nil, map[string]any{"limit": map[string]any{"type": "integer"}}),
		},
	}
}

func (s *Server) callAutoTool(name string, args json.RawMessage) (any, error) {
	var req autoRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	switch name {
	case "auto_list_rules":
		return s.opAutoRules(req.Project)
	case "auto_save_rule":
		return s.opAutoSaveRule(req)
	case "auto_delete_rule":
		return s.opAutoDeleteRule(req)
	case "auto_set_enabled":
		return s.opAutoSetEnabled(req)
	case "auto_run_rule":
		return s.opAutoRun(req)
	case "auto_list_runs":
		return s.opAutoRuns(req)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}
