// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const leftContent = document.getElementById('left-content');
  const rightContent = document.getElementById('right-content');
  const centerContent = document.getElementById('center-content');
  const conflictFile = document.getElementById('conflict-file');
  const confirmBtn = document.getElementById('confirm-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const takeMine = document.getElementById('take-mine');
  const takeTheirs = document.getElementById('take-theirs');
  const confirmStatus = document.getElementById('confirm-status');
  const resolvedBadge = document.getElementById('resolved-badge');

  let state = null;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      state = msg.state;
      render();
    } else if (msg.type === 'stateUpdate') {
      state = msg.state;
      renderStatus();
    }
  });

  function render() {
    if (!state) return;
    if (conflictFile) conflictFile.textContent = '⚠ ' + state.path;
    if (leftContent) leftContent.textContent = state.leftText;
    if (rightContent) rightContent.textContent = state.rightText;
    if (centerContent) centerContent.value = state.resolutionText;
    renderStatus();
  }

  function renderStatus() {
    if (!state) return;
    const hasMarkers = state.resolutionText.includes('<<<<<<<');
    if (resolvedBadge) resolvedBadge.classList.toggle('hidden', hasMarkers);
    if (confirmBtn) confirmBtn.disabled = hasMarkers || state.confirmedByMe;

    const confirmCount = state.confirmedPeers.length;
    const totalPeers = state.peers.length;
    if (confirmStatus) {
      confirmStatus.textContent = confirmCount + '/' + totalPeers + ' confirmed';
    }
  }

  centerContent?.addEventListener('input', () => {
    if (!state) return;
    state.resolutionText = centerContent.value;
    renderStatus();
    vscode.postMessage({ type: 'textChange', text: centerContent.value });
  });

  takeMine?.addEventListener('click', () => {
    if (!state || !centerContent) return;
    centerContent.value = state.leftText;
    state.resolutionText = state.leftText;
    renderStatus();
    vscode.postMessage({ type: 'textChange', text: state.leftText });
  });

  takeTheirs?.addEventListener('click', () => {
    if (!state || !centerContent) return;
    centerContent.value = state.rightText;
    state.resolutionText = state.rightText;
    renderStatus();
    vscode.postMessage({ type: 'textChange', text: state.rightText });
  });

  confirmBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'confirm', text: centerContent?.value ?? '' });
  });

  cancelBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
})();
