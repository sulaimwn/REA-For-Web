const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'notes.json');

function listNotes() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return [];
  }
}

function saveNote(note) {
  const notes = listNotes();
  notes.push(note);
  fs.writeFileSync(file(), JSON.stringify(notes));
  return notes.length;
}

module.exports = { listNotes, saveNote };
