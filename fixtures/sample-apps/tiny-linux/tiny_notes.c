// TinyNotes for Linux: a hand-written sample with a known answer key (ANSWER-KEY.md).
// Built by build.sh into an x86-64 ELF with symbols. Only ever read by REA; never run.
#include <netdb.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static const char NOTES_FILE[] = "notes.txt";
static const char SETTINGS_FILE[] = "settings.ini";
static const char SYNC_URL[] = "https://api.example.com/notes";

/* Appends one note to the notes file. */
void save_note(const char *text) {
  FILE *f = fopen(NOTES_FILE, "a");
  if (!f) return;
  fwrite(text, 1, strlen(text), f);
  fclose(f);
}

/* Remembers the last note's title in a settings file. */
void remember_last(const char *title) {
  FILE *f = fopen(SETTINGS_FILE, "w");
  if (!f) return;
  fprintf(f, "last=%s\n", title);
  fclose(f);
}

/* Sends the notes to the sync service. */
int sync_notes(void) {
  struct addrinfo *addr = NULL;
  if (getaddrinfo("api.example.com", "443", NULL, &addr) != 0) return -1;
  int fd = socket(addr->ai_family, SOCK_STREAM, 0);
  if (fd >= 0 && connect(fd, addr->ai_addr, addr->ai_addrlen) == 0) {
    char request[256];
    snprintf(request, sizeof request, "POST %s\r\n", SYNC_URL);
    send(fd, request, strlen(request), 0);
  }
  if (fd >= 0) close(fd);
  freeaddrinfo(addr);
  return 0;
}

int main(int argc, char **argv) {
  const char *text = argc > 1 ? argv[1] : "hello";
  save_note(text);
  remember_last(text);
  sync_notes();
  puts("saved");
  return 0;
}
