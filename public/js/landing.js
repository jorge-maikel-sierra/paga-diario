/**
 * Interactividad de la landing page: revelado al hacer scroll, contadores
 * animados, acordeón de FAQ, nav sticky con blur, copiar credenciales demo
 * y menú móvil. Sin dependencias, respeta prefers-reduced-motion.
 */
(function () {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Revelado al hacer scroll ---
  const revealTargets = document.querySelectorAll('[data-reveal]');
  if (prefersReducedMotion) {
    revealTargets.forEach((el) => el.classList.add('is-visible'));
  } else if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
    );
    revealTargets.forEach((el) => revealObserver.observe(el));

    // Red de seguridad: un salto de scroll instantáneo (anchor link, "Volver
    // arriba", etc.) puede saltarse el cruce gradual del viewport que el
    // observer necesita para disparar. Nada debe quedar oculto para siempre.
    setTimeout(() => {
      document.querySelectorAll('[data-reveal]:not(.is-visible)').forEach((el) => {
        el.classList.add('is-visible');
      });
    }, 2500);
  } else {
    revealTargets.forEach((el) => el.classList.add('is-visible'));
  }

  // --- Contadores animados ---
  const counters = document.querySelectorAll('[data-count-to]');
  const animateCounter = (el) => {
    const target = Number(el.dataset.countTo);
    const prefix = el.dataset.countPrefix || '';
    const suffix = el.dataset.countSuffix || '';
    if (prefersReducedMotion || !Number.isFinite(target)) {
      el.textContent = prefix + target.toLocaleString('es-CO') + suffix;
      return;
    }
    const duration = 1400;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - (1 - progress) ** 3; // ease-out cubic
      const value = Math.round(target * eased);
      el.textContent = prefix + value.toLocaleString('es-CO') + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  if ('IntersectionObserver' in window) {
    const counterObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            counterObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 },
    );
    counters.forEach((el) => counterObserver.observe(el));
  } else {
    counters.forEach(animateCounter);
  }

  // --- Nav sticky con blur al hacer scroll ---
  const nav = document.getElementById('landing-nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // --- Menú móvil ---
  const mobileToggle = document.getElementById('landing-mobile-toggle');
  const mobileMenu = document.getElementById('landing-mobile-menu');
  mobileToggle?.addEventListener('click', () => {
    const isOpen = !mobileMenu.classList.contains('hidden');
    mobileMenu.classList.toggle('hidden', isOpen);
    mobileToggle.setAttribute('aria-expanded', String(!isOpen));
  });
  mobileMenu?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => mobileMenu.classList.add('hidden'));
  });

  // --- Theme toggle (mismo patrón que el panel admin) ---
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });
  });

  // --- Copiar credenciales demo ---
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '¡Copiado! ✅';
      } catch {
        btn.textContent = 'No se pudo copiar';
      }
      setTimeout(() => { btn.textContent = original; }, 1600);
    });
  });

  // --- FAQ acordeón ---
  document.querySelectorAll('[data-faq-trigger]').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const panel = trigger.nextElementSibling;
      const isOpen = trigger.getAttribute('aria-expanded') === 'true';

      document.querySelectorAll('[data-faq-trigger]').forEach((other) => {
        if (other === trigger) return;
        other.setAttribute('aria-expanded', 'false');
        other.nextElementSibling.style.maxHeight = '0px';
        other.querySelector('[data-faq-icon]')?.classList.remove('rotate-45');
      });

      trigger.setAttribute('aria-expanded', String(!isOpen));
      trigger.querySelector('[data-faq-icon]')?.classList.toggle('rotate-45', !isOpen);
      panel.style.maxHeight = isOpen ? '0px' : `${panel.scrollHeight}px`;
    });
  });
})();
