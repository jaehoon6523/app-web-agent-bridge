using System;
using System.Runtime.InteropServices;

namespace Bridge {
    // IFileDialog's native vtable order must be preserved, including unused slots.
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr value);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    public static class NativeFolderPicker {
        public static string Show(IntPtr owner) {
            var dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(
                new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
            IShellItem item = null;
            IntPtr name = IntPtr.Zero;
            try {
                uint options;
                dialog.GetOptions(out options);
                // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR
                dialog.SetOptions(options | 0x20u | 0x40u | 0x800u | 0x8u);
                dialog.SetTitle("프로젝트 폴더 선택");
                dialog.SetOkButtonLabel("이 폴더 선택");
                int result = dialog.Show(owner);
                if (result == unchecked((int)0x800704C7)) return null; // User cancelled.
                Marshal.ThrowExceptionForHR(result);
                dialog.GetResult(out item);
                item.GetDisplayName(0x80058000u, out name); // SIGDN_FILESYSPATH
                return Marshal.PtrToStringUni(name);
            } finally {
                if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
                if (item != null) Marshal.FinalReleaseComObject(item);
                Marshal.FinalReleaseComObject(dialog);
            }
        }
    }
}
