// Toggle upload container visibility
document.addEventListener('DOMContentLoaded', function() {
  const uploadBtn = document.querySelector('.btn.upload');
  const uploadContainer = document.querySelector('.upload-container');

  if (!uploadBtn || !uploadContainer) return;

  // Initialize: hide upload container by default
  uploadContainer.style.display = 'none';

  // Toggle upload container on button click
  uploadBtn.addEventListener('click', function() {
    if (uploadContainer.style.display === 'none') {
      uploadContainer.style.display = 'block';
    } else {
      uploadContainer.style.display = 'none';
    }
  });
});
