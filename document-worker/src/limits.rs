// OS memory limits adapted from N2-Daebung under its included MIT license.
const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
#[cfg(windows)]
pub fn memory_guard() -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    // SAFETY: the owned Win32 handle and initialized structure have matching sizes;
    // only this worker process is assigned to the unnamed job, before parsing begins.
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let handle = OwnedHandle::from_raw_handle(raw);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit = MEMORY_LIMIT;
        if SetInformationJobObject(
            handle.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(handle.as_raw_handle(), GetCurrentProcess()) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(handle)
    }
}

#[cfg(unix)]
pub fn memory_guard() -> std::io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: MEMORY_LIMIT as _,
        rlim_max: MEMORY_LIMIT as _,
    };
    // SAFETY: this worker owns its resource limits; the pointer is initialized.
    if unsafe { libc::setrlimit(libc::RLIMIT_AS, &limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
