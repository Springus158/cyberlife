package jira

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Issue is a minimal view of a Jira issue used to prefill task details
type Issue struct {
	Key            string `json:"key"`
	Summary        string `json:"summary"`
	Status         string `json:"status"`
	StatusCategory string `json:"statusCategory,omitempty"` // new | indeterminate | done
	Type           string `json:"type"`
	Assignee       string `json:"assignee"`
	Priority       string `json:"priority,omitempty"`
	URL            string `json:"url"`
}

type issueResponse struct {
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Status  struct {
			Name string `json:"name"`
		} `json:"status"`
		IssueType struct {
			Name string `json:"name"`
		} `json:"issuetype"`
		Assignee struct {
			DisplayName string `json:"displayName"`
		} `json:"assignee"`
	} `json:"fields"`
}

// TestConnection verifies credentials by fetching the current user, returning their display name
func TestConnection(baseURL, email, apiToken string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return "", fmt.Errorf("jira base URL is not configured")
	}

	req, err := http.NewRequest("GET", base+"/rest/api/3/myself", nil)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(email, apiToken)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("jira returned status %d", resp.StatusCode)
	}

	var user struct {
		DisplayName string `json:"displayName"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return "", err
	}
	return user.DisplayName, nil
}

// GetIssue fetches an issue from Jira Cloud via the REST API using basic auth (email + API token)
func GetIssue(baseURL, email, apiToken, key string) (*Issue, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return nil, fmt.Errorf("jira base URL is not configured")
	}

	endpoint := fmt.Sprintf("%s/rest/api/3/issue/%s?fields=summary,status,issuetype,assignee", base, url.PathEscape(strings.TrimSpace(key)))
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(email, apiToken)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("issue %s not found", key)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("jira authentication failed (status %d)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("jira returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var parsed issueResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}

	return &Issue{
		Key:      parsed.Key,
		Summary:  parsed.Fields.Summary,
		Status:   parsed.Fields.Status.Name,
		Type:     parsed.Fields.IssueType.Name,
		Assignee: parsed.Fields.Assignee.DisplayName,
		URL:      fmt.Sprintf("%s/browse/%s", base, parsed.Key),
	}, nil
}

// SearchIssues runs a JQL query and returns matching issues (priority included)
func SearchIssues(baseURL, email, apiToken, jql string, maxResults int) ([]Issue, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return nil, fmt.Errorf("jira base URL is not configured")
	}
	endpoint := fmt.Sprintf("%s/rest/api/3/search/jql?jql=%s&maxResults=%d&fields=summary,status,issuetype,assignee,priority",
		base, url.QueryEscape(jql), maxResults)

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(email, apiToken)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return nil, fmt.Errorf("jira search returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out struct {
		Issues []struct {
			Key    string `json:"key"`
			Fields struct {
				Summary string `json:"summary"`
				Status  struct {
					Name           string `json:"name"`
					StatusCategory struct {
						Key string `json:"key"`
					} `json:"statusCategory"`
				} `json:"status"`
				IssueType struct {
					Name string `json:"name"`
				} `json:"issuetype"`
				Assignee struct {
					DisplayName string `json:"displayName"`
				} `json:"assignee"`
				Priority struct {
					Name string `json:"name"`
				} `json:"priority"`
			} `json:"fields"`
		} `json:"issues"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}

	issues := make([]Issue, 0, len(out.Issues))
	for _, i := range out.Issues {
		issues = append(issues, Issue{
			Key:            i.Key,
			Summary:        i.Fields.Summary,
			Status:         i.Fields.Status.Name,
			StatusCategory: i.Fields.Status.StatusCategory.Key,
			Type:           i.Fields.IssueType.Name,
			Assignee:       i.Fields.Assignee.DisplayName,
			Priority:       i.Fields.Priority.Name,
			URL:            base + "/browse/" + i.Key,
		})
	}
	return issues, nil
}

// Transition is one available Jira workflow move for an issue
type Transition struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ToName string `json:"toName"`
}

func ListTransitions(baseURL, email, apiToken, key string) ([]Transition, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	req, err := http.NewRequest("GET", base+"/rest/api/3/issue/"+url.PathEscape(key)+"/transitions", nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(email, apiToken)
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jira transitions returned status %d", resp.StatusCode)
	}
	var out struct {
		Transitions []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			To   struct {
				Name string `json:"name"`
			} `json:"to"`
		} `json:"transitions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	transitions := make([]Transition, 0, len(out.Transitions))
	for _, t := range out.Transitions {
		transitions = append(transitions, Transition{ID: t.ID, Name: t.Name, ToName: t.To.Name})
	}
	return transitions, nil
}

func DoTransition(baseURL, email, apiToken, key, transitionID string) error {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	body := strings.NewReader(fmt.Sprintf(`{"transition":{"id":%q}}`, transitionID))
	req, err := http.NewRequest("POST", base+"/rest/api/3/issue/"+url.PathEscape(key)+"/transitions", body)
	if err != nil {
		return err
	}
	req.SetBasicAuth(email, apiToken)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jira transition returned status %d", resp.StatusCode)
	}
	return nil
}
