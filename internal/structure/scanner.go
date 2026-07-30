package structure

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FileNode represents a file or directory in the project structure
type FileNode struct {
	Name      string     `json:"name"`
	Path      string     `json:"path"`
	IsDir     bool       `json:"isDir"`
	Children  []FileNode `json:"children,omitempty"`
	FileCount int        `json:"fileCount,omitempty"` // Count of JS/TS files (for directories only)
}

// Scanner scans project directories for JS/TS files
type Scanner struct {
	// Directories to ignore
	ignoredDirs map[string]bool
	// File extensions to include
	allowedExtensions map[string]bool
}

// NewScanner creates a new Scanner instance
func NewScanner() *Scanner {
	return &Scanner{
		ignoredDirs: map[string]bool{
			"node_modules": true,
			".git":         true,
			"dist":         true,
			"build":        true,
			".next":        true,
			".nuxt":        true,
			"coverage":     true,
			".cache":       true,
			".turbo":       true,
			"out":          true,
			".output":      true,
			"vendor":       true,
			".vscode":      true,
			".idea":        true,
		},
		allowedExtensions: map[string]bool{
			".js":     true,
			".jsx":    true,
			".ts":     true,
			".tsx":    true,
			".mjs":    true,
			".mts":    true,
			".cjs":    true,
			".cts":    true,
			".vue":    true,
			".svelte": true,
		},
	}
}

// ScanProject scans the project directory and returns the file tree
func (s *Scanner) ScanProject(projectPath string) (*FileNode, error) {
	// Verify path exists
	info, err := os.Stat(projectPath)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, os.ErrNotExist
	}

	root := s.scanDir(projectPath, filepath.Base(projectPath))
	return root, nil
}

// scanDir recursively scans a directory
func (s *Scanner) scanDir(dirPath, name string) *FileNode {
	node := &FileNode{
		Name:     name,
		Path:     dirPath,
		IsDir:    true,
		Children: []FileNode{},
	}

	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return node
	}

	var dirs []os.DirEntry
	var files []os.DirEntry

	// Separate dirs and files
	for _, entry := range entries {
		entryName := entry.Name()

		// Skip hidden files/dirs (except specific ones we want)
		if strings.HasPrefix(entryName, ".") && entryName != ".claude" {
			continue
		}

		if entry.IsDir() {
			// Skip ignored directories
			if s.ignoredDirs[entryName] {
				continue
			}
			dirs = append(dirs, entry)
		} else {
			// Only include files with allowed extensions
			ext := strings.ToLower(filepath.Ext(entryName))
			if s.allowedExtensions[ext] {
				files = append(files, entry)
			}
		}
	}

	// Sort dirs and files alphabetically
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name()) < strings.ToLower(dirs[j].Name())
	})
	sort.Slice(files, func(i, j int) bool {
		return strings.ToLower(files[i].Name()) < strings.ToLower(files[j].Name())
	})

	// Process directories first
	for _, dir := range dirs {
		childPath := filepath.Join(dirPath, dir.Name())
		childNode := s.scanDir(childPath, dir.Name())
		// Only add directories that have JS/TS files or subdirectories with JS/TS files
		if childNode.FileCount > 0 || len(childNode.Children) > 0 {
			node.Children = append(node.Children, *childNode)
			node.FileCount += childNode.FileCount
		}
	}

	// Then add files
	for _, file := range files {
		filePath := filepath.Join(dirPath, file.Name())
		node.Children = append(node.Children, FileNode{
			Name:  file.Name(),
			Path:  filePath,
			IsDir: false,
		})
		node.FileCount++
	}

	return node
}

// GetFolderHierarchy returns only the folder structure (no files) for graph visualization
func (s *Scanner) GetFolderHierarchy(projectPath string) (*FileNode, error) {
	fullTree, err := s.ScanProject(projectPath)
	if err != nil {
		return nil, err
	}

	// Strip files, keep only directories
	return s.filterDirsOnly(fullTree), nil
}

// filterDirsOnly recursively removes files from the tree
func (s *Scanner) filterDirsOnly(node *FileNode) *FileNode {
	if node == nil {
		return nil
	}

	result := &FileNode{
		Name:      node.Name,
		Path:      node.Path,
		IsDir:     true,
		FileCount: node.FileCount,
		Children:  []FileNode{},
	}

	for _, child := range node.Children {
		if child.IsDir {
			filtered := s.filterDirsOnly(&child)
			if filtered != nil {
				result.Children = append(result.Children, *filtered)
			}
		}
	}

	return result
}
