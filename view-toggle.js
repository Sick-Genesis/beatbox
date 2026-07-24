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
      // carousel.js's positioning math reads the container's live width —
      // while it was display:none (true at load, since list view shows
      // first) that width was 0, so every item's spacing/depth computed to
      // 0 and they rendered stacked on top of each other until some later
      // interaction (like clicking an item) forced a recompute. Now that
      // the container has just become visible and has a real width, force
      // that recompute immediately.
      window.beatCarousel?.rebuild?.();
    });
  }

  // Initialize: show list view by default
  listContainer.style.display = 'block';
  carouselContainer.style.display = 'none';
});
