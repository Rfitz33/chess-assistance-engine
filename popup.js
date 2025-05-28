document.addEventListener('DOMContentLoaded', function() {
  const toggleButton = document.getElementById('toggleButton');
  const strengthSlider = document.getElementById('strengthSlider');
  const strengthValue = document.getElementById('strengthValue');
  
  // Load saved state
  chrome.storage.local.get(['enabled', 'strength'], function(result) {
    const enabled = result.enabled ?? false;
    const strength = result.strength ?? 1.0;
    
    toggleButton.classList.toggle('disabled', !enabled);
    toggleButton.textContent = enabled ? 'Disable Assistant' : 'Enable Assistant';
    strengthSlider.value = Math.round(strength * 100);
    strengthValue.textContent = strength.toFixed(2);
  });

  // Toggle button handler
  toggleButton.addEventListener('click', function() {
    const enabled = toggleButton.classList.toggle('disabled');
    toggleButton.textContent = enabled ? 'Enable Assistant' : 'Disable Assistant';
    
    chrome.storage.local.set({ enabled: !enabled });
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'toggleAssistant',
        enabled: !enabled
      });
    });
  });

  // Strength slider handler
  strengthSlider.addEventListener('input', function() {
    const strength = this.value / 100;
    strengthValue.textContent = strength.toFixed(2);
    
    chrome.storage.local.set({ strength });
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'updateStrength',
        strength
      });
    });
  });
}); 