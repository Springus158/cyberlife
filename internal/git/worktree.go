package git

import (
	"fmt"
	"os/exec"
	"strings"
)

func runGit(repoPath string, args ...string) (string, error) {
	fullArgs := append([]string{"-C", repoPath}, args...)
	cmd := exec.Command("git", fullArgs...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

// BranchExists checks if a local branch exists in the repository
func (m *Manager) BranchExists(repoPath, branch string) bool {
	_, err := runGit(repoPath, "rev-parse", "--verify", "refs/heads/"+branch)
	return err == nil
}

// AddWorktree creates a worktree at worktreePath on the given branch.
// If the branch doesn't exist it is created from baseBranch (or HEAD when empty).
func (m *Manager) AddWorktree(repoPath, worktreePath, branch, baseBranch string) error {
	if m.BranchExists(repoPath, branch) {
		_, err := runGit(repoPath, "worktree", "add", worktreePath, branch)
		return err
	}

	args := []string{"worktree", "add", "-b", branch, worktreePath}
	if baseBranch != "" {
		args = append(args, baseBranch)
	}
	_, err := runGit(repoPath, args...)
	return err
}

// RemoveWorktree removes a worktree; force discards uncommitted changes
func (m *Manager) RemoveWorktree(repoPath, worktreePath string, force bool) error {
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, worktreePath)
	_, err := runGit(repoPath, args...)
	return err
}

// DeleteBranch deletes a local branch; force deletes even if unmerged
func (m *Manager) DeleteBranch(repoPath, branch string, force bool) error {
	flag := "-d"
	if force {
		flag = "-D"
	}
	_, err := runGit(repoPath, "branch", flag, branch)
	return err
}
