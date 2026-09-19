#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn only_fixed_help_destinations_are_allowed() {
        let resources = Path::new("missing-help-resources");
        assert_eq!(
            help_target(resources, "repository").unwrap(),
            "https://github.com/CAATZ/bimmerstein-bin-analyzer"
        );
        assert_eq!(
            help_target(resources, "issues").unwrap(),
            "https://github.com/CAATZ/bimmerstein-bin-analyzer/issues"
        );
        for target in [
            "https://example.com",
            "../../desktop.exe",
            "cmd.exe",
            "",
            "manual/../../file",
        ] {
            assert!(help_target(resources, target).is_err());
        }
        assert!(help_target(resources, "manual")
            .unwrap_err()
            .contains("not found"));
        assert!(help_target(resources, "license")
            .unwrap_err()
            .contains("not found"));
    }

    #[test]
    fn local_help_requires_the_bundled_files() {
        let resources =
            std::env::temp_dir().join(format!("binanalyzer-help-test-{}", std::process::id()));
        std::fs::create_dir_all(&resources).unwrap();
        for (target, file) in [
            ("manual", "BimmerStein-Bin-Analyzer-User-Manual.pdf"),
            ("license", "LICENSE"),
        ] {
            let path = resources.join(file);
            std::fs::write(&path, b"test resource").unwrap();
            assert_eq!(
                help_target(&resources, target).unwrap(),
                path.to_string_lossy()
            );
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(resources).unwrap();
    }
}
use std::path::Path;

pub fn help_target(resources: &Path, target: &str) -> Result<String, String> {
    let file = match target {
        "repository" => return Ok("https://github.com/CAATZ/bimmerstein-bin-analyzer".into()),
        "issues" => return Ok("https://github.com/CAATZ/bimmerstein-bin-analyzer/issues".into()),
        "manual" => "BimmerStein-Bin-Analyzer-User-Manual.pdf",
        "license" => "LICENSE",
        _ => return Err("Unknown help destination".into()),
    };
    let path = resources.join(file);
    if !path.is_file() {
        return Err(format!(
            "Bundled {file} not found. Reinstall the application to restore it."
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}
