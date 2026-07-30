package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Agent represents a Claude Code agent
type Agent struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsGlobal bool   `json:"isGlobal"`
	Format   string `json:"format"` // "yaml" | "md"
}

// Skill represents a Claude Code skill
type Skill struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description"`
	Installed   bool   `json:"installed"`
}

// Command represents a Claude Code slash command
type Command struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description"`
	IsGlobal    bool   `json:"isGlobal"`
	Content     string `json:"content,omitempty"`
}

// LibStatus represents the installation status of a library
type LibStatus struct {
	Name      string   `json:"name"`
	Installed bool     `json:"installed"`
	Version   string   `json:"version,omitempty"`
	Apps      []string `json:"apps,omitempty"` // List of apps where this library is installed
}

// UnifiedSkill represents a skill or command with full metadata across projects
type UnifiedSkill struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Path         string            `json:"path"`
	DirPath      string            `json:"dirPath"`     // Directory containing the skill
	Project      string            `json:"project"`     // Project name (or "global")
	ProjectPath  string            `json:"projectPath"` // Project root path
	Source       string            `json:"source"`      // "skills" or "commands"
	IsGlobal     bool              `json:"isGlobal"`
	Content      string            `json:"content,omitempty"`
	Frontmatter  map[string]string `json:"frontmatter,omitempty"`
	HasSupport   bool              `json:"hasSupport"` // Has supporting files beyond SKILL.md
	SupportFiles []string          `json:"supportFiles,omitempty"`
}

const (
	SourceTypeSkills   = "skills"
	SourceTypeCommands = "commands"
)

// ToolsManager handles Claude Code tools (agents, skills, hooks)
type ToolsManager struct {
	homeDir string
}

// NewToolsManager creates a new tools manager
func NewToolsManager() *ToolsManager {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return &ToolsManager{
		homeDir: home,
	}
}

// getAgentsFromDir reads agents from a directory
func (m *ToolsManager) getAgentsFromDir(dir string, isGlobal bool) ([]Agent, error) {
	agents := []Agent{}

	// Check if directory exists
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return agents, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return agents, err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))

		// Support yaml, yml, and md files
		if ext == ".yaml" || ext == ".yml" || ext == ".md" {
			format := "yaml"
			if ext == ".md" {
				format = "md"
			}

			agents = append(agents, Agent{
				Name:     strings.TrimSuffix(name, ext),
				Path:     filepath.Join(dir, name),
				IsGlobal: isGlobal,
				Format:   format,
			})
		}
	}

	return agents, nil
}

// getSkillDescription reads the description from a skill's manifest or README
func (m *ToolsManager) getSkillDescription(skillPath string) string {
	// Try to read from package.json or manifest.json
	manifestPaths := []string{
		filepath.Join(skillPath, "manifest.json"),
		filepath.Join(skillPath, "package.json"),
	}

	for _, manifestPath := range manifestPaths {
		if content, err := os.ReadFile(manifestPath); err == nil {
			var manifest map[string]interface{}
			if json.Unmarshal(content, &manifest) == nil {
				if desc, ok := manifest["description"].(string); ok {
					return desc
				}
			}
		}
	}

	// Try README
	readmePaths := []string{
		filepath.Join(skillPath, "README.md"),
		filepath.Join(skillPath, "readme.md"),
	}

	for _, readmePath := range readmePaths {
		if content, err := os.ReadFile(readmePath); err == nil {
			// Return first line as description
			lines := strings.Split(string(content), "\n")
			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "#") {
					if len(line) > 100 {
						return line[:100] + "..."
					}
					return line
				}
			}
		}
	}

	return ""
}

// copyDir recursively copies a directory
func copyDir(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := os.MkdirAll(dstPath, 0755); err != nil {
				return err
			}
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			content, err := os.ReadFile(srcPath)
			if err != nil {
				return err
			}
			if err := os.WriteFile(dstPath, content, 0644); err != nil {
				return err
			}
		}
	}

	return nil
}

// AppDependencies holds dependencies for a specific app/package
type AppDependencies struct {
	AppName string
	Deps    map[string]string
}

// GetProjectDependencies reads dependencies from package.json (root only, for backward compat)
func (m *ToolsManager) GetProjectDependencies(projectPath string) (map[string]string, error) {
	deps := make(map[string]string)

	packagePath := filepath.Join(projectPath, "package.json")
	content, err := os.ReadFile(packagePath)
	if err != nil {
		if os.IsNotExist(err) {
			return deps, nil
		}
		return deps, err
	}

	var pkg map[string]interface{}
	if err := json.Unmarshal(content, &pkg); err != nil {
		return deps, err
	}

	// Merge dependencies and devDependencies
	for _, key := range []string{"dependencies", "devDependencies"} {
		if depsMap, ok := pkg[key].(map[string]interface{}); ok {
			for name, version := range depsMap {
				if v, ok := version.(string); ok {
					deps[name] = v
				}
			}
		}
	}

	return deps, nil
}

// GetAllProjectDependencies reads dependencies from root and all apps in monorepo structure
func (m *ToolsManager) GetAllProjectDependencies(projectPath string) ([]AppDependencies, error) {
	var allDeps []AppDependencies

	// Read root package.json
	rootDeps, err := m.readPackageJson(filepath.Join(projectPath, "package.json"))
	if err == nil && len(rootDeps) > 0 {
		allDeps = append(allDeps, AppDependencies{
			AppName: "root",
			Deps:    rootDeps,
		})
	}

	// Check for monorepo structures: apps/, packages/, workspaces/
	monorepoFolders := []string{"apps", "packages", "workspaces"}

	for _, folder := range monorepoFolders {
		folderPath := filepath.Join(projectPath, folder)
		if _, err := os.Stat(folderPath); os.IsNotExist(err) {
			continue
		}

		entries, err := os.ReadDir(folderPath)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}

			appPath := filepath.Join(folderPath, entry.Name(), "package.json")
			appDeps, err := m.readPackageJson(appPath)
			if err != nil || len(appDeps) == 0 {
				continue
			}

			allDeps = append(allDeps, AppDependencies{
				AppName: entry.Name(),
				Deps:    appDeps,
			})
		}
	}

	return allDeps, nil
}

// readPackageJson reads and parses a package.json file
func (m *ToolsManager) readPackageJson(path string) (map[string]string, error) {
	deps := make(map[string]string)

	content, err := os.ReadFile(path)
	if err != nil {
		return deps, err
	}

	var pkg map[string]interface{}
	if err := json.Unmarshal(content, &pkg); err != nil {
		return deps, err
	}

	// Merge dependencies and devDependencies
	for _, key := range []string{"dependencies", "devDependencies"} {
		if depsMap, ok := pkg[key].(map[string]interface{}); ok {
			for name, version := range depsMap {
				if v, ok := version.(string); ok {
					deps[name] = v
				}
			}
		}
	}

	return deps, nil
}

// CheckLibraryStatus checks which libraries from a list are installed (across all apps)
func (m *ToolsManager) CheckLibraryStatus(projectPath string, libs []string) ([]LibStatus, error) {
	allDeps, err := m.GetAllProjectDependencies(projectPath)
	if err != nil {
		return nil, err
	}

	// Build a map of lib -> apps where it's installed
	libApps := make(map[string][]string)
	libVersions := make(map[string]string)

	for _, appDeps := range allDeps {
		for libName, version := range appDeps.Deps {
			if libApps[libName] == nil {
				libApps[libName] = []string{}
			}
			libApps[libName] = append(libApps[libName], appDeps.AppName)
			// Store the first version found
			if libVersions[libName] == "" {
				libVersions[libName] = version
			}
		}
	}

	// Build status for requested libs
	statuses := make([]LibStatus, len(libs))
	for i, lib := range libs {
		apps := libApps[lib]
		installed := len(apps) > 0
		statuses[i] = LibStatus{
			Name:      lib,
			Installed: installed,
			Version:   libVersions[lib],
			Apps:      apps,
		}
	}

	return statuses, nil
}

// getCommandsFromDir reads commands from a directory (supports nested directories)
func (m *ToolsManager) getCommandsFromDir(dir string, isGlobal bool) ([]Command, error) {
	commands := []Command{}

	// Check if directory exists
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return commands, nil
	}

	// Walk directory recursively
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}
		if info.IsDir() {
			return nil
		}

		// Only support .md files
		if strings.ToLower(filepath.Ext(info.Name())) != ".md" {
			return nil
		}

		// Get relative path from commands dir for command name
		relPath, _ := filepath.Rel(dir, path)
		// Remove .md extension
		name := strings.TrimSuffix(relPath, ".md")
		// Replace path separators with : for nested commands
		name = strings.ReplaceAll(name, string(filepath.Separator), ":")

		// Read content to extract description
		content, _ := os.ReadFile(path)
		description := m.extractCommandDescription(string(content))

		commands = append(commands, Command{
			Name:        name,
			Path:        path,
			Description: description,
			IsGlobal:    isGlobal,
		})

		return nil
	})

	return commands, err
}

// extractCommandDescription extracts description from command content using parseFrontmatter
func (m *ToolsManager) extractCommandDescription(content string) string {
	fm := parseFrontmatter(content)
	return fm["description"]
}

// ============================================
// Enhanced Hooks Methods
// ============================================

// extractDescriptionFromContent extracts description from file content
func (m *ToolsManager) extractDescriptionFromContent(content string) string {
	lines := strings.Split(content, "\n")

	// Check for YAML frontmatter
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		for i := 1; i < len(lines); i++ {
			line := strings.TrimSpace(lines[i])
			if line == "---" {
				break
			}
			if strings.HasPrefix(line, "description:") {
				desc := strings.TrimPrefix(line, "description:")
				desc = strings.TrimSpace(desc)
				desc = strings.Trim(desc, "\"'")
				return desc
			}
		}
	}

	// Look for first heading or paragraph
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || line == "---" {
			continue
		}
		// Skip headings, return first content line
		if strings.HasPrefix(line, "#") {
			continue
		}
		if len(line) > 100 {
			return line[:100] + "..."
		}
		return line
	}

	return ""
}

// ============================================
// Unified Skills Dashboard Methods
// ============================================

// parseFrontmatter extracts YAML frontmatter from a skill/command file.
// If no description is found in frontmatter, falls back to the first non-empty content line.
func parseFrontmatter(content string) map[string]string {
	fm := make(map[string]string)
	lines := strings.Split(content, "\n")

	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return fm
	}

	foundClose := false
	bodyStart := len(lines)
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "---" {
			foundClose = true
			bodyStart = i + 1
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && parts[0] != "" {
			key := strings.TrimSpace(parts[0])
			value := strings.TrimSpace(parts[1])
			value = strings.Trim(value, "\"'")
			fm[key] = value
		}
	}

	// No closing --- means no valid frontmatter
	if !foundClose {
		return make(map[string]string)
	}

	// Fallback: if no description in frontmatter, use first non-empty content line
	if fm["description"] == "" {
		for i := bodyStart; i < len(lines); i++ {
			line := strings.TrimSpace(lines[i])
			if line != "" && !strings.HasPrefix(line, "#") {
				if len(line) > 100 {
					line = line[:100] + "..."
				}
				fm["description"] = line
				break
			}
		}
	}

	return fm
}

// getSupportFiles returns non-SKILL.md files in a skill directory
func getSupportFiles(dirPath string) []string {
	var files []string
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return files
	}
	for _, entry := range entries {
		if entry.Name() == "SKILL.md" {
			continue
		}
		files = append(files, entry.Name())
	}
	return files
}

// ============================================
// F14: Composition Builder
// ============================================

// ============================================
// F15: Skill Analytics & Usage Tracking
// ============================================
