/**
 * Comportamiento del sidebar: toggle de tema claro/oscuro, colapso a
 * modo icono en escritorio, y apertura como overlay en móvil.
 * Sin dependencias — un solo archivo cargado por _sidebar.ejs.
 */
(function () {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const mobileToggle = document.getElementById('mobile-sidebar-toggle');
  const themeToggle = document.getElementById('theme-toggle');
  const collapseToggle = document.getElementById('sidebar-collapse-toggle');
  const collapseIcon = document.getElementById('sidebar-collapse-icon');

  // --- Tema claro/oscuro ---
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });
  }

  // --- Menú móvil (overlay) ---
  const openMobileSidebar = () => {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
    mobileToggle?.setAttribute('aria-expanded', 'true');
  };
  const closeMobileSidebar = () => {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
    mobileToggle?.setAttribute('aria-expanded', 'false');
  };
  mobileToggle?.addEventListener('click', () => {
    const isOpen = !sidebar.classList.contains('-translate-x-full');
    if (isOpen) closeMobileSidebar();
    else openMobileSidebar();
  });
  backdrop?.addEventListener('click', closeMobileSidebar);
  sidebar?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.innerWidth < 1024) closeMobileSidebar();
    });
  });

  // --- Colapsar a modo icono (solo escritorio) ---
  // La clase vive en <html> (ver header.ejs) para poder aplicarse antes
  // del primer pintado y evitar el parpadeo del sidebar expandido.
  collapseToggle?.addEventListener('click', () => {
    const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  });
  if (document.documentElement.classList.contains('sidebar-collapsed')) {
    collapseIcon?.classList.add('rotate-180');
  }
})();
