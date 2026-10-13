// Tiny native Windows sample for REA for Web fixtures (see ANSWER-KEY.md).
// Built by build.sh with mingw-w64 in Docker; only ever read by REA, never run.
#include <windows.h>
#include <wininet.h>
#include <string.h>

static const wchar_t *SYNC_URL = L"https://api.example.com/notes";
static const wchar_t *CONFIG_KEY = L"Software\\TinyNotes";

/* Writes a note to a file. */
int save_note(const wchar_t *path, const char *text) {
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  DWORD written = 0;
  if (file == INVALID_HANDLE_VALUE) return 0;
  WriteFile(file, text, (DWORD)strlen(text), &written, NULL);
  CloseHandle(file);
  return (int)written;
}

/* Remembers the last note in the registry. */
int remember_last(const wchar_t *path) {
  HKEY key;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, CONFIG_KEY, 0, NULL, 0, KEY_WRITE, NULL, &key, NULL) != ERROR_SUCCESS) return 0;
  RegSetValueExW(key, L"LastNote", 0, REG_SZ, (const BYTE *)path, (DWORD)((wcslen(path) + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  return 1;
}

/* Pushes notes to the sync endpoint. */
int sync_notes(void) {
  HINTERNET net = InternetOpenW(L"TinyNotes", INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
  HINTERNET url = InternetOpenUrlW(net, SYNC_URL, NULL, 0, 0, 0);
  int ok = url != NULL;
  if (url) InternetCloseHandle(url);
  InternetCloseHandle(net);
  return ok;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command, int show) {
  (void)instance; (void)previous; (void)command; (void)show;
  save_note(L"note.txt", "hello");
  remember_last(L"note.txt");
  sync_notes();
  MessageBoxW(NULL, L"Saved", L"TinyNotes", MB_OK);
  return 0;
}
