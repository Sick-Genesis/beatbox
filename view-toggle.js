// Toggle between list view and carousel view
document.addEventListener('DOMContentLoaded', function() {
  const listViewBtn = document.querySelector('.btn.list-view');
  const carouselBtn = document.querySelector('.btn.carousel');
  const listContainer = document.querySelector('.list-container');
  const carouselContainer = document.querySelector('.carousel-container');

  // Show list container, hide carousel container
  if (listViewBtn) {
    listViewBtn.addEventListener('click', function() {
      listContainer.style.display = 'block';
      carouselContainer.style.display = 'none';
    });
  }

  // Show carousel container, hide list container
  if (carouselBtn) {
    carouselBtn.addEventListener('click', function() {
      carouselContainer.style.display = 'block';
      listContainer.style.display = 'none';
    });
  }

  // Initialize: show list view by default
  listContainer.style.display = 'block';
  carouselContainer.style.display = 'none';
});
