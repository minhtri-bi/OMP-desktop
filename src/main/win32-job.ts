import koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
const ERROR_INVALID_PARAMETER = 87;

export type Win32JobPrepareResult =
  | { ok: true }
  | { ok: false; reason: string };

export type Win32JobAssignResult =
  | { ok: true }
  | { ok: false; reason: string; processAlreadyExited: boolean };

export interface JobObjectSupervisor {
  isAssigned(): boolean;
  prepare?(): Win32JobPrepareResult;
  assignProcess(pid: number): Win32JobAssignResult;
  terminateAndClose(exitCode?: number): void;
}

interface Kernel32Bindings {
  CreateJobObjectW: (lpJobAttributes: null, lpName: null) => unknown;
  SetInformationJobObject: (
    hJob: unknown,
    infoClass: number,
    lpJobObjectInfo: Record<string, unknown>,
    cbJobObjectInfoLength: number,
  ) => boolean;
  OpenProcess: (dwDesiredAccess: number, bInheritHandle: boolean, dwProcessId: number) => unknown;
  AssignProcessToJobObject: (hJob: unknown, hProcess: unknown) => boolean;
  GetExitCodeProcess: (hProcess: unknown, lpExitCode: number[]) => boolean;
  GetLastError: () => number;
  TerminateJobObject: (hJob: unknown, uExitCode: number) => boolean;
  CloseHandle: (hObject: unknown) => boolean;
  extendedLimitSize: number;
}

let cachedKernel32: Kernel32Bindings | null | undefined;

function getKernel32(): Kernel32Bindings | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedKernel32 !== undefined) {
    return cachedKernel32;
  }
  try {
    const lib = koffi.load("kernel32.dll");

    const BasicLimitStruct = koffi.struct("OMP_JOBOBJECT_BASIC_LIMIT_INFORMATION", {
      PerProcessUserTimeLimit: "int64",
      PerJobUserTimeLimit: "int64",
      LimitFlags: "uint32",
      MinimumWorkingSetSize: "size_t",
      MaximumWorkingSetSize: "size_t",
      ActiveProcessLimit: "uint32",
      Affinity: "uintptr_t",
      PriorityClass: "uint32",
      SchedulingClass: "uint32",
    });

    const IoCountersStruct = koffi.struct("OMP_IO_COUNTERS", {
      ReadOperationCount: "uint64",
      WriteOperationCount: "uint64",
      OtherOperationCount: "uint64",
      ReadTransferCount: "uint64",
      WriteTransferCount: "uint64",
      OtherTransferCount: "uint64",
    });

    const ExtendedLimitStruct = koffi.struct("OMP_JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
      BasicLimitInformation: BasicLimitStruct,
      IoInfo: IoCountersStruct,
      ProcessMemoryLimit: "size_t",
      JobMemoryLimit: "size_t",
      PeakProcessMemoryUsed: "size_t",
      PeakJobMemoryUsed: "size_t",
    });

    cachedKernel32 = {
      CreateJobObjectW: lib.func("void * __stdcall CreateJobObjectW(void *lpJobAttributes, const char16_t *lpName)") as Kernel32Bindings["CreateJobObjectW"],
      SetInformationJobObject: lib.func(
        "bool __stdcall SetInformationJobObject(void *hJob, int infoClass, OMP_JOBOBJECT_EXTENDED_LIMIT_INFORMATION *lpInfo, uint32 cbLength)",
      ) as Kernel32Bindings["SetInformationJobObject"],
      OpenProcess: lib.func(
        "void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)",
      ) as Kernel32Bindings["OpenProcess"],
      AssignProcessToJobObject: lib.func(
        "bool __stdcall AssignProcessToJobObject(void *hJob, void *hProcess)",
      ) as Kernel32Bindings["AssignProcessToJobObject"],
      GetExitCodeProcess: lib.func("__stdcall", "GetExitCodeProcess", "bool", [
        "void *",
        koffi.out(koffi.pointer("uint32")),
      ]) as Kernel32Bindings["GetExitCodeProcess"],
      GetLastError: lib.func("uint32 __stdcall GetLastError()") as Kernel32Bindings["GetLastError"],
      TerminateJobObject: lib.func(
        "bool __stdcall TerminateJobObject(void *hJob, uint32 uExitCode)",
      ) as Kernel32Bindings["TerminateJobObject"],
      CloseHandle: lib.func("bool __stdcall CloseHandle(void *hObject)") as Kernel32Bindings["CloseHandle"],
      extendedLimitSize: ExtendedLimitStruct.size,
    };
    return cachedKernel32;
  } catch {
    cachedKernel32 = null;
    return null;
  }
}

function isPidMissing(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Supervises a spawned Windows child process via a Win32 Job Object configured with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so both `omp.exe` and any descendant tool processes
 * are guaranteed to terminate if the desktop host crashes or disposes the adapter.
 */
export class Win32JobObject implements JobObjectSupervisor {
  private jobHandle: unknown = null;
  private assigned = false;

  isAssigned(): boolean {
    return this.assigned && this.jobHandle !== null;
  }

  prepare(): Win32JobPrepareResult {
    if (process.platform !== "win32") {
      return {
        ok: false,
        reason: "Win32 Job Object supervision is only available on Windows.",
      };
    }
    if (this.jobHandle) {
      return { ok: true };
    }
    const k32 = getKernel32();
    if (!k32) {
      return {
        ok: false,
        reason: "Failed to initialize kernel32.dll Job Object bindings.",
      };
    }

    const hJob = k32.CreateJobObjectW(null, null);
    if (!hJob) {
      const lastErr = k32.GetLastError();
      return {
        ok: false,
        reason: `CreateJobObjectW failed (Win32 error ${lastErr}).`,
      };
    }

    const info = {
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0,
        PerJobUserTimeLimit: 0,
        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0,
        MaximumWorkingSetSize: 0,
        ActiveProcessLimit: 0,
        Affinity: 0,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0,
        WriteOperationCount: 0,
        OtherOperationCount: 0,
        ReadTransferCount: 0,
        WriteTransferCount: 0,
        OtherTransferCount: 0,
      },
      ProcessMemoryLimit: 0,
      JobMemoryLimit: 0,
      PeakProcessMemoryUsed: 0,
      PeakJobMemoryUsed: 0,
    };

    const configured = k32.SetInformationJobObject(
      hJob,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
      info,
      k32.extendedLimitSize,
    );
    if (!configured) {
      const lastErr = k32.GetLastError();
      k32.CloseHandle(hJob);
      return {
        ok: false,
        reason: `SetInformationJobObject failed (Win32 error ${lastErr}).`,
      };
    }
    this.jobHandle = hJob;
    return { ok: true };
  }

  assignProcess(pid: number): Win32JobAssignResult {
    if (process.platform !== "win32") {
      return {
        ok: false,
        reason: "Win32 Job Object supervision is only available on Windows.",
        processAlreadyExited: false,
      };
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      return {
        ok: false,
        reason: `Invalid process ID (${pid}).`,
        processAlreadyExited: false,
      };
    }
    const prepared = this.prepare();
    if (!prepared.ok) {
      return {
        ok: false,
        reason: prepared.reason,
        processAlreadyExited: false,
      };
    }
    const k32 = getKernel32()!;

    const hProcess = k32.OpenProcess(
      PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
      false,
      pid,
    );
    if (!hProcess) {
      const lastErr = k32.GetLastError();
      const exited = lastErr === ERROR_INVALID_PARAMETER || isPidMissing(pid);
      this.terminateAndClose();
      return {
        ok: false,
        reason: `OpenProcess failed for pid ${pid} (Win32 error ${lastErr}).`,
        processAlreadyExited: exited,
      };
    }

    try {
      const ok = k32.AssignProcessToJobObject(this.jobHandle, hProcess);
      if (!ok) {
        const lastErr = k32.GetLastError();
        const exitCodeOut = [0];
        const gotExitCode = k32.GetExitCodeProcess(hProcess, exitCodeOut);
        const exited = (gotExitCode && exitCodeOut[0] !== STILL_ACTIVE) || isPidMissing(pid);
        this.terminateAndClose();
        return {
          ok: false,
          reason: `AssignProcessToJobObject failed for pid ${pid} (Win32 error ${lastErr}).`,
          processAlreadyExited: exited,
        };
      }
      this.assigned = true;
      return { ok: true };
    } finally {
      k32.CloseHandle(hProcess);
    }
  }

  /**
   * Idempotently terminates any remaining processes in the Job Object and closes the kernel handle.
   */
  terminateAndClose(exitCode = 1): void {
    const handle = this.jobHandle;
    const wasAssigned = this.assigned;
    this.jobHandle = null;
    this.assigned = false;
    if (!handle) {
      return;
    }
    const k32 = getKernel32();
    if (!k32) {
      return;
    }
    try {
      if (wasAssigned) {
        k32.TerminateJobObject(handle, exitCode);
      }
    } finally {
      k32.CloseHandle(handle);
    }
  }
}
