export function renderList(notes) {
  const ul = document.getElementById('list');
  ul.innerHTML = '';
  for (const n of notes) {
    const li = document.createElement('li');
    li.textContent = n.text;
    ul.appendChild(li);
  }
}
