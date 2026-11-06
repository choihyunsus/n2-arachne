// Darwin's initial virtual mappings can exceed a small RLIMIT_AS budget.
// Monitor the worker's peak resident bytes instead, with explicit sampling limits.
use std::io;
use std::mem::MaybeUninit;
use std::time::Duration;

fn peak_resident_bytes() -> io::Result<usize> {
    let mut usage = MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage receives a properly sized, aligned, writable local structure.
    // On success Darwin supplies ru_maxrss from task resident_size_max, in bytes.
    let peak = unsafe {
        if libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) != 0 {
            return Err(io::Error::last_os_error());
        }
        usage.assume_init().ru_maxrss
    };
    usize::try_from(peak).map_err(|_| io::Error::other("Invalid process memory measurement"))
}

pub(super) fn start_watchdog(limit: usize) -> io::Result<()> {
    if peak_resident_bytes()? > limit {
        return Err(io::Error::other("Document memory budget exceeded"));
    }
    std::thread::Builder::new()
        .name("document-memory-budget".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(10));
            match peak_resident_bytes() {
                Ok(bytes) if bytes <= limit => continue,
                _ => {
                    eprintln!("Document memory budget exceeded or measurement failed");
                    std::process::exit(125);
                }
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_resident_measurement_is_available() {
        assert!(peak_resident_bytes().unwrap() > 0);
    }

    #[test]
    fn macos_watchdog_stops_an_over_budget_child() {
        const CHILD_FLAG: &str = "ARACHNE_MEMORY_TEST_CHILD";
        const MIB: usize = 1024 * 1024;
        if std::env::var_os(CHILD_FLAG).is_some() {
            start_watchdog(peak_resident_bytes().unwrap() + MIB).unwrap();
            let bytes = vec![1_u8; 8 * MIB];
            std::hint::black_box(&bytes);
            std::thread::sleep(Duration::from_secs(2));
            panic!("Memory watchdog did not stop the child");
        }
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "limits::macos::tests::macos_watchdog_stops_an_over_budget_child",
            ])
            .env(CHILD_FLAG, "1")
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(125), "{result:?}");
        assert!(String::from_utf8_lossy(&result.stderr).contains("memory budget"));
    }
}
