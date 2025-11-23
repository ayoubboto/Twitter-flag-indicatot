const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

const toggleSwitch = document.getElementById('toggleSwitch');
const status = document.getElementById('status');

chrome.storage.local.get([TOGGLE_KEY], (result) => {
  const isEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
  updateToggle(isEnabled);
});

toggleSwitch.addEventListener('click', () => {
  chrome.storage.local.get([TOGGLE_KEY], (result) => {
    const currentState = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    const newState = !currentState;

    chrome.storage.local.set({ [TOGGLE_KEY]: newState }, () => {
      updateToggle(newState);

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'extensionToggle',
            enabled: newState
          }).catch(() => {
          });
        }
      });
    });
  });
});

const statusDot = document.querySelector('.status-dot');

function updateToggle(isEnabled) {
  if (isEnabled) {
    toggleSwitch.classList.add('enabled');
    statusDot.classList.add('active');
    status.textContent = 'Enabled';
    status.style.color = '#fff';
  } else {
    toggleSwitch.classList.remove('enabled');
    statusDot.classList.remove('active');
    status.textContent = 'Disabled';
    status.style.color = 'rgba(255, 255, 255, 0.5)';
  }
}
