package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/kalor62/cyberlife/internal/logging"
	appversion "github.com/kalor62/cyberlife/internal/version"
)

// Minimal stateless MCP Streamable HTTP endpoint: one POST route, three
// JSON-RPC methods (initialize, tools/list, tools/call). No sessions, no SSE —
// every request is self-contained, which is all a local tools server needs.

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func rpcResult(id json.RawMessage, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func rpcFail(id json.RawMessage, code int, msg string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError{Code: code, Message: msg}}
}

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func objSchema(required []string, props map[string]any) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

var projectProp = map[string]any{
	"type":        "string",
	"description": "Project name, id, or any path inside the project (pass your working directory)",
}

func (s *Server) mcpTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "board_list_projects",
			Description: "List Cyber Life projects (id, name, path)",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "board_get",
			Description: "Read a project's kanban board: columns and tasks",
			InputSchema: objSchema([]string{"project"}, map[string]any{"project": projectProp}),
		},
		{
			Name:        "board_create_task",
			Description: "Create a kanban task. Column by name (e.g. Backlog); omitted = first column.",
			InputSchema: objSchema([]string{"project", "title"}, map[string]any{
				"project":     projectProp,
				"title":       map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
				"column":      map[string]any{"type": "string"},
				"priority":    map[string]any{"type": "string", "enum": []string{"low", "medium", "high"}},
				"category":    map[string]any{"type": "string"},
			}),
		},
		{
			Name:        "board_update_task",
			Description: "Update fields of an existing task (title, description, priority, category, blocked, archived, column)",
			InputSchema: objSchema([]string{"project", "taskId"}, map[string]any{
				"project":     projectProp,
				"taskId":      map[string]any{"type": "string"},
				"title":       map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
				"column":      map[string]any{"type": "string"},
				"priority":    map[string]any{"type": "string", "enum": []string{"low", "medium", "high"}},
				"category":    map[string]any{"type": "string"},
				"blocked":     map[string]any{"type": "boolean"},
				"archived":    map[string]any{"type": "boolean"},
			}),
		},
		{
			Name:        "board_move_task",
			Description: "Move a task to a column (status change), e.g. to \"Done\" when finished",
			InputSchema: objSchema([]string{"project", "taskId", "column"}, map[string]any{
				"project": projectProp,
				"taskId":  map[string]any{"type": "string"},
				"column":  map[string]any{"type": "string"},
				"index":   map[string]any{"type": "integer", "description": "Position in the column; omitted = end"},
			}),
		},
		{
			Name:        "board_comment",
			Description: "Add a comment to a task; set author to your model/agent name",
			InputSchema: objSchema([]string{"project", "taskId", "text"}, map[string]any{
				"project": projectProp,
				"taskId":  map[string]any{"type": "string"},
				"text":    map[string]any{"type": "string"},
				"author":  map[string]any{"type": "string"},
			}),
		},
		{
			Name:        "board_map_jira",
			Description: "Bind a project's board to a Jira project key for two-way sync (empty jiraKey unbinds). jiraFilter is extra JQL ANDed onto the sync query, e.g. \"assignee = currentUser()\" or \"sprint in openSprints()\".",
			InputSchema: objSchema([]string{"project"}, map[string]any{
				"project":    projectProp,
				"jiraKey":    map[string]any{"type": "string", "description": "Jira project key, e.g. ABC"},
				"jiraFilter": map[string]any{"type": "string", "description": "Extra JQL narrowing which issues sync onto the board"},
			}),
		},
		{
			Name:        "board_sync_jira",
			Description: "Pull the mapped Jira project's issues onto the board now",
			InputSchema: objSchema([]string{"project"}, map[string]any{"project": projectProp}),
		},
	}
}

func (s *Server) callTool(name string, args json.RawMessage) (any, error) {
	var req taskRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	switch name {
	case "board_list_projects":
		return s.opProjects()
	case "board_get":
		return s.opBoard(req.Project)
	case "board_create_task", "board_update_task":
		return s.opTask(req)
	case "board_move_task":
		return s.opMove(req)
	case "board_comment":
		return s.opComment(req)
	case "board_map_jira":
		return s.opJiraMapReq(req)
	case "board_sync_jira":
		return s.opJiraSyncReq(req)
	default:
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, rpcFail(nil, -32700, "parse error"))
		return
	}

	// Notifications need no response body
	if req.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			logging.Debug("mcp: initialize params parse failed", "error", err)
		}
		version := p.ProtocolVersion
		if version == "" {
			version = "2025-03-26"
		}
		writeJSON(w, http.StatusOK, rpcResult(req.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "cyberlife", "version": appversion.Number},
		}))
	case "ping":
		writeJSON(w, http.StatusOK, rpcResult(req.ID, map[string]any{}))
	case "tools/list":
		tools := []mcpTool{}
		for _, g := range s.toolGroups() {
			if s.groupEnabled(g.id) {
				tools = append(tools, g.tools()...)
			}
		}
		writeJSON(w, http.StatusOK, rpcResult(req.ID, map[string]any{"tools": tools}))
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			writeJSON(w, http.StatusOK, rpcFail(req.ID, -32602, "invalid params"))
			return
		}
		var result any
		var err error
		group, ok := s.groupForTool(p.Name)
		switch {
		case !ok:
			result, err = nil, fmt.Errorf("unknown tool %q", p.Name)
		case !s.groupEnabled(group.id):
			writeJSON(w, http.StatusOK, rpcResult(req.ID, toolError(groupDisabledErr(group.id).Error())))
			return
		default:
			result, err = group.call(p.Name, p.Arguments)
		}
		if err != nil {
			writeJSON(w, http.StatusOK, rpcResult(req.ID, toolError(err.Error())))
			return
		}
		payload, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			writeJSON(w, http.StatusOK, rpcResult(req.ID, toolError(err.Error())))
			return
		}
		writeJSON(w, http.StatusOK, rpcResult(req.ID, map[string]any{
			"content": []map[string]any{{"type": "text", "text": string(payload)}},
		}))
	default:
		writeJSON(w, http.StatusOK, rpcFail(req.ID, -32601, "method not found"))
	}
}

func toolError(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}
