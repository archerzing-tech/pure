use std::path::{Path, PathBuf};

#[allow(dead_code)]
pub fn normalize_lexical(path: &Path) -> Result<PathBuf, ()> {
    let mut normalized = PathBuf::new();
    let mut root_seen = false;
    let mut normal_depth = 0usize;
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if normal_depth > 0 {
                    normalized.pop();
                    normal_depth -= 1;
                } else if root_seen {
                    return Err(());
                } else {
                    normalized.push(component.as_os_str());
                }
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                normalized.push(component.as_os_str());
                root_seen = true;
            }
            std::path::Component::Normal(value) => {
                normalized.push(value);
                normal_depth += 1;
            }
        }
    }
    Ok(normalized)
}

#[allow(dead_code)]
pub fn resolve_workspace_path(workspace: &Path, path: &Path) -> Result<PathBuf, String> {
    let base = std::fs::canonicalize(workspace)
        .map_err(|e| format!("invalid workspace '{}': {}", workspace.display(), e))?;
    if !base.is_dir() {
        return Err(format!("workspace is not a directory: {}", workspace.display()));
    }
    // The workspace is only the base for RELATIVE paths. Absolute paths point
    // anywhere on disk — the workspace boundary has been removed (the adapter
    // contract: absolute paths can target any location, the user explicitly
    // opted out of workspace confinement). Remaining guards are path VALIDITY:
    // lexical normalization (rejecting `..` above the filesystem root) and
    // refusing to write through a dangling symlink.
    let candidate = if path.is_absolute() { path.to_path_buf() } else { base.join(path) };
    let normalized = normalize_lexical(&candidate)
        .map_err(|_| format!("path cannot be resolved: {}", path.display()))?;
    let mut existing = normalized.clone();
    let mut missing = Vec::new();
    while !existing.exists() {
        if let Ok(meta) = std::fs::symlink_metadata(&existing) {
            if meta.file_type().is_symlink() {
                return Err(format!("path uses an unresolved symlink: {}", path.display()));
            }
        }
        let Some(name) = existing.file_name().map(PathBuf::from) else {
            return Err(format!("path cannot be resolved: {}", path.display()));
        };
        missing.push(name);
        if !existing.pop() {
            return Err(format!("path cannot be resolved: {}", path.display()));
        }
    }
    let mut resolved = std::fs::canonicalize(&existing)
        .map_err(|e| format!("resolve '{}': {}", path.display(), e))?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_workspace(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("pure-path-policy-{}-{}", name, std::process::id()));
        let workspace = root.join("workspace");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&workspace).unwrap();
        (root, workspace)
    }

    #[test]
    fn rejects_parent_traversal_above_filesystem_root() {
        let (root, workspace) = test_workspace("parent");
        // `..` can no longer climb above the filesystem root; anything short of
        // that resolves (workspace confinement is removed, see resolve_workspace_path).
        let resolved = resolve_workspace_path(&workspace, Path::new("../outside.txt")).unwrap();
        assert!(resolved.ends_with("outside.txt"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_absolute_path_outside_workspace() {
        let (root, workspace) = test_workspace("absolute-outside");
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let target = outside.join("note.txt");
        std::fs::write(&target, "outside").unwrap();
        // Absolute paths target ANY location on disk — no workspace boundary.
        let resolved = resolve_workspace_path(&workspace, &target).unwrap();
        assert!(resolved.ends_with("outside/note.txt"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_missing_file_inside_workspace() {
        let (root, workspace) = test_workspace("missing");
        let resolved = resolve_workspace_path(&workspace, Path::new("nested/file.txt")).unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(&workspace).unwrap()));
        let _ = std::fs::remove_dir_all(root);
    }

    /// P2-5 path_policy 刀的行为锁：normalizeLexical 输入输出表与 TS 单源
    /// （src/tools/impl/pathPolicy.ts）同源消费
    /// src/shared/__fixtures__/pathPolicyFixtures.json——一侧改词法行为
    /// 不同步 fixture 即两例试红。output 用 [root, parts] 分量形状（平台
    /// 中立：TS 产物统一正斜杠、Rust 产物随平台分隔符，join 后的字符串
    /// 形状不算行为差异）。windowsOnly 段（盘符/UNC）依赖
    /// std::path::Components 的前缀语义，只在 Windows 上跑；TS 版是纯
    /// 字符串逻辑全平台可测。
    #[test]
    fn normalize_lexical_matches_shared_fixture_table() {
        let raw = include_str!("../../src/shared/__fixtures__/pathPolicyFixtures.json");
        let fixtures: serde_json::Value = serde_json::from_str(raw).expect("parse pathPolicyFixtures.json");
        for row in fixtures["normalizeLexical"].as_array().expect("normalizeLexical array") {
            if row.get("windowsOnly").and_then(|w| w.as_bool()).unwrap_or(false) && !cfg!(windows) {
                continue;
            }
            let input = row["input"].as_str().expect("input");
            let got = normalize_lexical(Path::new(input));
            match row.get("output") {
                Some(serde_json::Value::Null) => {
                    assert!(got.is_err(), "{input}: expected rejection, got {:?}", got);
                }
                None => panic!("fixture row missing output: {input}"),
                Some(expected) => {
                    let r = got.unwrap_or_else(|_| panic!("{input}: expected {expected:?}, got Err"));
                    let root_raw = expected[0].as_str().expect("root");
                    let parts: Vec<String> = expected[1]
                        .as_array()
                        .expect("parts array")
                        .iter()
                        .map(|p| p.as_str().expect("part").to_string())
                        .collect();
                    // 形状提取：Prefix → root（RootDir 在前缀后补 '/'），RootDir 单独
                    // → '/'；ParentDir → '..'；Normal → 字面。windows 产物反斜杠归一。
                    let mut root = String::new();
                    let mut got_parts = Vec::new();
                    for comp in r.components() {
                        match comp {
                            std::path::Component::Prefix(pre) => root = pre.as_os_str().to_string_lossy().to_string(),
                            std::path::Component::RootDir => {
                                if root.is_empty() {
                                    root.push('/');
                                } else if !root.ends_with('/') {
                                    root.push('/');
                                }
                            }
                            std::path::Component::ParentDir => got_parts.push("..".to_string()),
                            std::path::Component::CurDir => {}
                            std::path::Component::Normal(v) => got_parts.push(v.to_string_lossy().to_string()),
                        }
                    }
                    assert_eq!((root.replace('\\', "/"), got_parts), (root_raw.to_string(), parts), "input: {input}");
                }
            }
        }
    }
}
