import koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

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

/**
 * Supervises a spawned Windows child process via a Win32 Job Object configured with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so both `omp.exe` and any descendant tool processes
 * are guaranteed to terminate if the desktop host crashes or disposes the adapter.
 */
export class Win32JobObject {
  private jobHandle: unknown = null;
  private assigned = false;

  isAssigned(): boolean {
    return this.assigned && this.jobHandle !== null;
  }

  assignProcess(pid: number): boolean {
    if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    const k32 = getKernel32();
    if (!k32) {
      return false;
    }

    if (!this.jobHandle) {
      const hJob = k32.CreateJobObjectW(null, null);
      if (!hJob) {
        return false;
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
        k32.CloseHandle(hJob);
        return false;
      }
      this.jobHandle = hJob;
    }

    const hProcess = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (!hProcess) {
      this.terminateAndClose();
      return false;
    }

    try {
      const ok = k32.AssignProcessToJobObject(this.jobHandle, hProcess);
      if (!ok) {
        this.terminateAndClose();
        return false;
      }
      this.assigned = true;
      return true;
    } finally {
      k32.CloseHandle(hProcess);
    }
  }

  /**
   * Idempotently terminates any remaining processes in the Job Object and closes the kernel handle.
   */
  terminateAndClose(exitCode = 1): void {
    const handle = this.jobHandle;
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
      k32.TerminateJobObject(handle, exitCode);
    } finally {
      k32.CloseHandle(handle);
    }
  }
}
