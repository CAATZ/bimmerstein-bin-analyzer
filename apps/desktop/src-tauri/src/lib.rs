mod help;
use tauri::Manager;

#[tauri::command]
fn open_help(app: tauri::AppHandle, target: String) -> Result<(), String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let destination = help::help_target(&resources, &target)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(destination)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Could not open help: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = destination;
        Err("Opening help is currently supported on Windows only.".into())
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_help])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
