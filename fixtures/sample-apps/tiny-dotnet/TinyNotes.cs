// Tiny .NET sample for REA for Web fixtures. Hand-written so the answer key is known:
// see ANSWER-KEY.md next to this file. Never run as part of analysis.
using System;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

[assembly: AssemblyTitle("TinyNotes")]
[assembly: AssemblyCompany("REA for Web fixtures")]
[assembly: AssemblyVersion("1.2.3.0")]
[assembly: AssemblyFileVersion("1.2.3.0")]

namespace TinyNotes
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            var store = new NoteStore(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TinyNotes"));
            store.Save("hello", "first note");
            Native.MessageBoxW(IntPtr.Zero, store.Load("hello"), "TinyNotes", 0);
            var uptime = Native.GetTickCount64();
            var sealedNote = Native.SealNote("secret", 6);
            Console.WriteLine("{0} {1}", uptime, sealedNote);
            return Sync.PushAsync(store, "https://api.example.com/notes").GetAwaiter().GetResult() ? 0 : 1;
        }
    }

    public sealed class NoteStore
    {
        private readonly string root;

        public NoteStore(string root)
        {
            this.root = root;
            Directory.CreateDirectory(root);
        }

        public void Save(string name, string text)
        {
            File.WriteAllText(Path.Combine(root, name + ".txt"), text);
        }

        public string Load(string name)
        {
            return File.ReadAllText(Path.Combine(root, name + ".txt"));
        }
    }

    public static class Sync
    {
        public static async Task<bool> PushAsync(NoteStore store, string endpoint)
        {
            using (var client = new HttpClient())
            {
                var response = await client.PostAsync(endpoint, new StringContent(store.Load("hello")));
                return response.IsSuccessStatusCode;
            }
        }
    }

    internal static class Native
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

        [DllImport("kernel32.dll")]
        internal static extern ulong GetTickCount64();

        // A native library shipped next to the app (not included in the fixture).
        [DllImport("tinycrypto.dll", EntryPoint = "seal_note", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int SealNote([MarshalAs(UnmanagedType.LPStr)] string text, int length);
    }
}
