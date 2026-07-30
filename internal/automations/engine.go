// Package automations runs the trigger → rule → action engine. Rules live in
// app state (per project or global); the engine matches incoming events
// (task moves, cron ticks, new mail, manual runs) against them and executes
// actions through callbacks supplied by the app layer, logging every run.
package automations

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/state"
)

// Store is the slice of the state manager the engine needs
type Store interface {
	GetAutomationRules() []state.AutomationRule
	GetAutomationRule(id string) (state.AutomationRule, bool)
	TouchAutomationRule(id string, at time.Time)
	AppendAutomationRun(run state.AutomationRun) state.AutomationRun
	ResolveProject(ref string) (*state.ProjectState, bool)
	GetKanban(projectID string) ([]state.KanbanColumn, []state.KanbanTask, error)
}

// Actions are the executors the app provides. MoveTask must not re-enter the
// engine (automation-triggered moves don't cascade into other rules).
type Actions struct {
	RunAgent  func(workDir, tabName, runnerID, prompt string) (sessionID string, err error)
	MoveTask  func(projectID, taskID, column string) error
	Comment   func(projectID, taskID, author, text string) error
	Notify    func(title, message string) error
	SendMail  func(account, to, subject, body string) error
	EmitEvent func(event string, payload map[string]string)
	OnRun     func(run state.AutomationRun)
}

type Engine struct {
	store Store
	act   Actions

	cronStop chan struct{}
	cronOnce sync.Once
}

func NewEngine(store Store, act Actions) *Engine {
	return &Engine{store: store, act: act, cronStop: make(chan struct{})}
}

// fireContext carries what the trigger knew; placeholders and link IDs on the
// run record come from here
type fireContext struct {
	trigger      string
	projectID    string
	taskID       string
	mailThreadID string
	vars         map[string]string
}

// ============================================
// Trigger intake
// ============================================

// TaskMoved fires task-status rules for a task that entered a column.
// Executions run async; a failed rule only shows up in the run log.
func (e *Engine) TaskMoved(projectID, taskID, columnID string) {
	columns, tasks, err := e.store.GetKanban(projectID)
	if err != nil {
		logging.Warn("automations: board load failed", "project", projectID, "error", err)
		return
	}
	var columnName string
	for _, c := range columns {
		if c.ID == columnID {
			columnName = c.Name
			break
		}
	}
	var taskTitle string
	for _, t := range tasks {
		if t.ID == taskID {
			taskTitle = t.Title
			break
		}
	}
	project, _ := e.store.ResolveProject(projectID)

	for _, rule := range e.matchRules(projectID, func(r state.AutomationRule) bool {
		return r.Trigger.Type == "task-status" &&
			(strings.EqualFold(r.Trigger.Column, columnName) || r.Trigger.Column == columnID)
	}) {
		ctx := fireContext{
			trigger:   fmt.Sprintf("task entered %q", columnName),
			projectID: projectID,
			taskID:    taskID,
			vars: map[string]string{
				"task.id":    taskID,
				"task.title": taskTitle,
				"column":     columnName,
			},
		}
		addProjectVars(ctx.vars, project)
		go e.execute(rule, ctx)
	}
}

// MailReceived fires mail rules for a new inbox thread (dedup is the caller's
// job — the app's poller only reports threads it has not seen before)
func (e *Engine) MailReceived(account, threadID, from, subject string) {
	for _, rule := range e.matchRules("", func(r state.AutomationRule) bool {
		if r.Trigger.Type != "mail" {
			return false
		}
		if r.Trigger.Account != "" && !strings.EqualFold(r.Trigger.Account, account) {
			return false
		}
		if r.Trigger.FromContains != "" && !containsFold(from, r.Trigger.FromContains) {
			return false
		}
		if r.Trigger.SubjectContains != "" && !containsFold(subject, r.Trigger.SubjectContains) {
			return false
		}
		return true
	}) {
		ctx := fireContext{
			trigger:      fmt.Sprintf("mail from %s", from),
			projectID:    rule.ProjectID,
			mailThreadID: threadID,
			vars: map[string]string{
				"mail.from":    from,
				"mail.subject": subject,
				"mail.thread":  threadID,
				"mail.account": account,
			},
		}
		if project, ok := e.store.ResolveProject(rule.ProjectID); ok {
			addProjectVars(ctx.vars, project)
		}
		go e.execute(rule, ctx)
	}
}

// FireWebhook runs rules listening on /api/hooks/<slug>. Top-level string
// fields of a JSON payload become {{hook.<key>}} placeholders; the raw body
// is {{hook.body}}. Returns how many rules matched.
func (e *Engine) FireWebhook(slug string, body []byte) int {
	rules := e.matchRules("", func(r state.AutomationRule) bool {
		return r.Trigger.Type == "webhook" && r.Trigger.Slug == slug
	})
	if len(rules) == 0 {
		return 0
	}
	vars := map[string]string{"hook.slug": slug, "hook.body": string(body)}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err == nil {
		for k, v := range payload {
			if s, ok := v.(string); ok {
				vars["hook."+k] = s
			}
		}
	}
	for _, rule := range rules {
		ctx := fireContext{trigger: fmt.Sprintf("webhook /%s", slug), projectID: rule.ProjectID, vars: map[string]string{}}
		for k, v := range vars {
			ctx.vars[k] = v
		}
		if project, ok := e.store.ResolveProject(rule.ProjectID); ok {
			addProjectVars(ctx.vars, project)
		}
		go e.execute(rule, ctx)
	}
	return len(rules)
}

// HasMailRules lets the mail poller skip API calls when nothing listens
func (e *Engine) HasMailRules() bool {
	for _, r := range e.store.GetAutomationRules() {
		if r.Enabled && r.Trigger.Type == "mail" {
			return true
		}
	}
	return false
}

// RunNow executes a rule immediately (any trigger type) and returns the run
func (e *Engine) RunNow(ruleID string) (state.AutomationRun, error) {
	rule, ok := e.store.GetAutomationRule(ruleID)
	if !ok {
		return state.AutomationRun{}, fmt.Errorf("rule %q not found", ruleID)
	}
	ctx := fireContext{trigger: "manual run", projectID: rule.ProjectID, vars: map[string]string{}}
	if project, ok := e.store.ResolveProject(rule.ProjectID); ok {
		addProjectVars(ctx.vars, project)
	}
	return e.execute(rule, ctx), nil
}

// StartCron begins the schedule loop; safe to call once at startup
func (e *Engine) StartCron() {
	e.cronOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-e.cronStop:
					return
				case now := <-ticker.C:
					e.cronTick(now)
				}
			}
		}()
	})
}

func (e *Engine) StopCron() {
	close(e.cronStop)
}

func (e *Engine) cronTick(now time.Time) {
	for _, rule := range e.store.GetAutomationRules() {
		if !rule.Enabled || rule.Trigger.Type != "cron" || !cronDue(rule, now) {
			continue
		}
		ctx := fireContext{trigger: "schedule", projectID: rule.ProjectID, vars: map[string]string{}}
		if project, ok := e.store.ResolveProject(rule.ProjectID); ok {
			addProjectVars(ctx.vars, project)
		}
		go e.execute(rule, ctx)
	}
}

func cronDue(rule state.AutomationRule, now time.Time) bool {
	last := rule.LastRunAt
	if rule.Trigger.EveryMinutes > 0 {
		if last == nil {
			return true
		}
		return now.Sub(*last) >= time.Duration(rule.Trigger.EveryMinutes)*time.Minute
	}
	if rule.Trigger.DailyAt != "" {
		at, err := time.Parse("15:04", rule.Trigger.DailyAt)
		if err != nil {
			return false
		}
		fire := time.Date(now.Year(), now.Month(), now.Day(), at.Hour(), at.Minute(), 0, 0, now.Location())
		if now.Before(fire) {
			return false
		}
		return last == nil || last.Before(fire)
	}
	return false
}

// ============================================
// Matching + execution
// ============================================

// matchRules returns enabled rules whose scope covers projectID (a rule with
// no project is global). An empty projectID matches every rule scope.
func (e *Engine) matchRules(projectID string, pred func(state.AutomationRule) bool) []state.AutomationRule {
	var out []state.AutomationRule
	for _, r := range e.store.GetAutomationRules() {
		if !r.Enabled || !pred(r) {
			continue
		}
		if r.ProjectID != "" && projectID != "" && r.ProjectID != projectID {
			continue
		}
		out = append(out, r)
	}
	return out
}

func (e *Engine) execute(rule state.AutomationRule, ctx fireContext) state.AutomationRun {
	ctx.vars["rule.name"] = rule.Name
	now := time.Now()
	run := state.AutomationRun{
		RuleID:       rule.ID,
		RuleName:     rule.Name,
		ProjectID:    ctx.projectID,
		TaskID:       ctx.taskID,
		MailThreadID: ctx.mailThreadID,
		Trigger:      ctx.trigger,
		StartedAt:    now,
	}

	var errs []string
	var done []string
	for _, action := range rule.Actions {
		if err := e.runAction(rule, action, &ctx, &run); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", action.Type, err))
		} else {
			done = append(done, action.Type)
		}
	}

	if len(errs) > 0 {
		run.Status = "error"
		run.Detail = strings.Join(errs, "; ")
	} else {
		run.Status = "ok"
		run.Detail = strings.Join(done, ", ")
	}

	e.store.TouchAutomationRule(rule.ID, now)
	run = e.store.AppendAutomationRun(run)
	logging.Info("automation ran", "rule", rule.Name, "trigger", ctx.trigger, "status", run.Status, "detail", run.Detail)
	if e.act.OnRun != nil {
		e.act.OnRun(run)
	}
	return run
}

func (e *Engine) runAction(rule state.AutomationRule, a state.AutomationAction, ctx *fireContext, run *state.AutomationRun) error {
	x := func(s string) string { return expand(s, ctx.vars) }
	switch a.Type {
	case "run-agent":
		if e.act.RunAgent == nil {
			return fmt.Errorf("not wired")
		}
		workDir := x(a.WorkDir)
		if workDir == "" {
			workDir = ctx.vars["project.path"]
		}
		if workDir == "" {
			return fmt.Errorf("no working directory (set workDir or scope the rule to a project)")
		}
		sessionID, err := e.act.RunAgent(workDir, "auto "+rule.Name, a.Runner, x(a.Prompt))
		if err != nil {
			return err
		}
		run.SessionID = sessionID
		ctx.vars["session.id"] = sessionID
		return nil
	case "move-task":
		if e.act.MoveTask == nil {
			return fmt.Errorf("not wired")
		}
		if ctx.taskID == "" {
			return fmt.Errorf("trigger carries no task")
		}
		return e.act.MoveTask(ctx.projectID, ctx.taskID, x(a.Column))
	case "comment":
		if e.act.Comment == nil {
			return fmt.Errorf("not wired")
		}
		if ctx.taskID == "" {
			return fmt.Errorf("trigger carries no task")
		}
		return e.act.Comment(ctx.projectID, ctx.taskID, "automation", x(a.Text))
	case "notify":
		if e.act.Notify == nil {
			return fmt.Errorf("not wired")
		}
		title := x(a.Title)
		if title == "" {
			title = rule.Name
		}
		return e.act.Notify(title, x(a.Message))
	case "send-mail":
		if e.act.SendMail == nil {
			return fmt.Errorf("not wired")
		}
		if a.To == "" {
			return fmt.Errorf("recipient (to) is required")
		}
		return e.act.SendMail(a.Account, x(a.To), x(a.Subject), x(a.Body))
	case "webhook":
		return postWebhook(x(a.URL), a.Method, x(a.Body))
	case "emit-event":
		if e.act.EmitEvent == nil {
			return fmt.Errorf("not wired")
		}
		if a.Event == "" {
			return fmt.Errorf("event name is required")
		}
		payload := make(map[string]string, len(ctx.vars)+1)
		for k, v := range ctx.vars {
			payload[k] = v
		}
		if a.Body != "" {
			payload["body"] = x(a.Body)
		}
		e.act.EmitEvent(a.Event, payload)
		return nil
	default:
		return fmt.Errorf("unknown action type")
	}
}

// postWebhook delivers to any HTTP endpoint — Slack/Discord/Telegram
// incoming webhooks or arbitrary services; the body template was already
// placeholder-expanded by the caller
func postWebhook(url, method, body string) error {
	if method == "" {
		method = http.MethodPost
	}
	req, err := http.NewRequest(strings.ToUpper(method), url, strings.NewReader(body))
	if err != nil {
		return fmt.Errorf("invalid webhook request")
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		// net/http embeds the full URL (webhook URLs carry tokens) in its
		// errors, and run details are persisted and readable by agents
		return fmt.Errorf("webhook request to %s failed", req.URL.Host)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook %s returned %d", req.URL.Host, resp.StatusCode)
	}
	return nil
}

// ============================================
// Helpers
// ============================================

func addProjectVars(vars map[string]string, project *state.ProjectState) {
	if project == nil {
		return
	}
	vars["project.id"] = project.ID
	vars["project.name"] = project.Name
	vars["project.path"] = project.Path
}

func expand(s string, vars map[string]string) string {
	if !strings.Contains(s, "{{") {
		return s
	}
	for k, v := range vars {
		s = strings.ReplaceAll(s, "{{"+k+"}}", v)
	}
	return s
}

func containsFold(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}
