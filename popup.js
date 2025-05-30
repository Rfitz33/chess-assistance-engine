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
    
    // Send message to all tabs matching chess.com
    chrome.tabs.query({url: 'https://www.chess.com/*'}, function(tabs) {
      if (tabs.length === 0) {
        console.log('No chess.com tabs found');
        return;
      }
      
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'toggleAssistant',
          enabled: !enabled
        }).catch(error => {
          console.log('Error sending message to tab:', error);
        });
      });
    });
  });

  // Strength slider handler
  strengthSlider.addEventListener('input', function() {
    const strength = this.value / 100;
    strengthValue.textContent = strength.toFixed(2);
    
    chrome.storage.local.set({ strength });
    
    // Send message to all tabs matching chess.com
    chrome.tabs.query({url: 'https://www.chess.com/*'}, function(tabs) {
      if (tabs.length === 0) {
        console.log('No chess.com tabs found');
        return;
      }
      
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'updateStrength',
          strength
        }).catch(error => {
          console.log('Error sending message to tab:', error);
        });
      });
    });
  });
}); 