// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const statusText = document.getElementById('status-text');
  const participantsList = document.getElementById('participants-list');

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'agentUpdate') {
      updateAgentChips(msg.agents);
      return;
    }
    if (msg.type !== 'stateUpdate') return;
    const state = msg.state;
    renderState(state);
  });

  function renderState(state) {
    if (!statusText || !participantsList) return;
    participantsList.innerHTML = '';
    switch (state.kind) {
      case 'Idle':
        statusText.textContent = 'Not connected';
        break;
      case 'Connecting':
        statusText.textContent = 'Connecting...';
        break;
      case 'Active':
        statusText.textContent = `Session active — ${state.participants.length} participant(s)`;
        renderParticipants(state.participants);
        break;
      case 'Reconnecting':
        statusText.textContent = `Reconnecting (attempt ${state.attempt})...`;
        if (state.participants) renderParticipants(state.participants);
        break;
      case 'Failed':
        statusText.textContent = `Error: ${state.reason}`;
        break;
    }
  }

  function renderParticipants(participants) {
    if (!participantsList) return;
    for (const p of participants) {
      const li = document.createElement('li');
      li.className = 'participant';
      li.dataset.participantId = p.id;
      li.innerHTML = `
        <span class="color-dot" style="background-color: ${escapeHtml(p.color)}"></span>
        <span class="participant-name">${escapeHtml(p.displayName)}</span>
        ${p.currentFile ? `<span class="participant-file">${escapeHtml(p.currentFile)}</span>` : ''}
      `;
      participantsList.appendChild(li);
    }
  }

  function updateAgentChips(agents) {
    if (!participantsList) return;
    const items = participantsList.querySelectorAll('li.participant');
    for (const li of items) {
      const id = li.dataset.participantId;
      if (!id) continue;
      let chip = li.querySelector('.agent-chip');
      const status = agents[id];
      if (!status || !status.agentActive) {
        chip?.remove();
        continue;
      }
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'agent-chip';
        li.appendChild(chip);
      }
      if (status.agentSourced) {
        chip.className = 'agent-chip sourced';
        chip.textContent = '⚡ agent';
      } else {
        chip.className = 'agent-chip';
        chip.textContent = '● writing';
      }
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
})();
