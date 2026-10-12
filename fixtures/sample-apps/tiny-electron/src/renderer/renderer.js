import { renderList } from './view.js';

document.getElementById('save').addEventListener('click', async () => {
  const text = document.getElementById('note').value;
  await window.notesApi.save({ text, at: Date.now() });
  renderList(await window.notesApi.list());
});
