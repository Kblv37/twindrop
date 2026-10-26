<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

const root = ref(null);
let observer = null;

onMounted(() => {
  const targets = root.value?.querySelectorAll('.fade-target') || [];

  if (!('IntersectionObserver' in window)) {
    targets.forEach((element) => element.classList.add('is-visible'));
    return;
  }

  observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer?.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  targets.forEach((element) => observer.observe(element));
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div ref="root" class="wrap">
    <h1 class="page-title">О проекте Twindrop</h1>

    <section class="section glass fade-target">
      <h2 class="section-title">Как это работает</h2>
      <ol>
        <li><b>Получатель</b> открывает страницу «Создать комнату» и получает уникальный 6‑значный код или QR‑код для подключения.</li>
        <li><b>Отправитель</b> открывает страницу «Подключиться», вводит этот код вручную или переходит по ссылке, после чего устанавливается соединение.</li>
        <li><b>Выбор скорости передачи:</b> перед началом отправки можно выбрать размер чанка — фрагмента файла, который передаётся за один раз. Для Safari и мобильных браузеров оптимален 128 KB или меньше, для Chrome, Edge и Firefox — 256 KB.</li>
        <li><b>Сигналинг</b> — только технический обмен данными (SDP/ICE) через сервер для установления P2P‑канала. Содержимое файлов через сервер не проходит.</li>
        <li><b>Передача</b> — файл отправляется напрямую между браузерами по зашифрованному каналу WebRTC DataChannel, порциями выбранного размера.</li>
        <li><b>Завершение</b> — после окончания сессии соединение закрывается, а данные нигде не сохраняются на сервере.</li>
      </ol>
    </section>

    <section class="section glass fade-target">
      <h2 class="section-title">Преимущества Twindrop</h2>
      <div class="about-features">
        <article class="feature-card">
          <div class="feature-heading">
            <span class="feature-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3 4.5 6v5.5c0 4.5 3.2 7.7 7.5 9.5 4.3-1.8 7.5-5 7.5-9.5V6L12 3Z"></path>
                <path d="m9 12 2 2 4-4"></path>
              </svg>
            </span>
            <h3>Безопасность</h3>
          </div>
          <p>Файлы доступны только отправителю и получателю. Канал передачи зашифрован на уровне WebRTC.</p>
        </article>
        <article class="feature-card">
          <div class="feature-heading">
            <span class="feature-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path>
              </svg>
            </span>
            <h3>Скорость</h3>
          </div>
          <p>Напрямую, без «облачных» задержек. Меньше посредников — выше пропускная способность и стабильность.</p>
        </article>
        <article class="feature-card">
          <div class="feature-heading">
            <span class="feature-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <path d="m3 3 18 18"></path>
                <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path>
                <path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c5.5 0 9 5.2 9 7 0 .8-.5 1.8-1.4 2.8"></path>
                <path d="M6.1 6.1C4.2 7.5 3 9.1 3 12c0 1.8 3.5 7 9 7 1.3 0 2.5-.3 3.5-.8"></path>
              </svg>
            </span>
            <h3>Анонимность</h3>
          </div>
          <p>Нет аккаунтов и логов содержимого. Сигналинг — минимальный и технический, только для установления связи.</p>
        </article>
      </div>
    </section>

    <section class="section glass fade-target">
      <h2 class="section-title">Технологии и архитектура</h2>
      <ul>
        <li><b>Vue 3 + Vite</b> для единого клиентского приложения с навигацией без перезагрузки страницы.</li>
        <li><b>WebRTC</b> для прямой P2P‑передачи и шифрования на уровне канала (DataChannel).</li>
        <li><b>Socket.IO</b> как минимальный слой сигналинга между участниками сессии.</li>
        <li><b>IndexedDB</b> для восстановления выбранной очереди файлов после перезагрузки.</li>
        <li><b>Коды и QR</b> для быстрого и надёжного паринга устройств, без регистрации.</li>
      </ul>
    </section>

    <section class="section glass fade-target">
      <h2 class="section-title">Ограничения и требования</h2>
      <ul>
        <li><b>Совместимость браузеров:</b> поддерживаются последние стабильные версии Chrome, Edge, Firefox и Safari. В старых версиях возможны ограничения по WebRTC.</li>
        <li><b>Сеть:</b> требуется стабильное интернет‑соединение. При сложных NAT‑конфигурациях или строгих фаерволах может понадобиться TURN‑сервер.</li>
        <li><b>Размеры файлов:</b> зависят от возможностей браузера, пропускной способности сети и настроек передачи.</li>
        <li><b>Большие файлы:</b> отправитель и получатель обрабатывают файл в памяти браузера. Настройка лимита не гарантирует успешную передачу очень больших файлов, особенно на устройствах с небольшим объёмом ОЗУ.</li>
        <li><b>Мобильные сети:</b> возможны кратковременные «провалы» соединения. WebRTC обычно восстанавливает канал автоматически.</li>
      </ul>

      <h3 class="small upper muted about-subheading">
        <span class="inline-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.1.4.3.7.6 1 .3.3.7.4 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6Z"></path>
          </svg>
        </span>
        Выбор скорости передачи и размера чанка
      </h3>
      <p>При отправке файла Twindrop позволяет выбрать размер чанка — фрагмента файла, который передаётся за один раз. Этот параметр влияет на скорость, стабильность соединения и нагрузку на устройство.</p>
      <p><b>Рекомендуемые значения:</b> для Safari и части мобильных браузеров — 128 KB; для Chrome, Edge, Firefox — 256 KB. Меньшие значения надёжнее в нестабильной сети, большие — быстрее при хорошем соединении.</p>
      <p><b>Совет:</b> если передача не удалась или файл повреждён, выберите меньший размер чанка и повторите отправку.</p>
    </section>

    <section class="section glass fade-target">
      <h2 class="section-title">Частые вопросы</h2>
      <h3 class="small upper muted">Файлы проходят через сервер?</h3>
      <p>Нет. Сервер используется только для сигналинга — установления соединения. Контент идёт по P2P.</p>
      <h3 class="small upper muted">Нужна регистрация или вход?</h3>
      <p>Нет. Достаточно 6‑значного кода или QR, сгенерированного получателем.</p>
      <h3 class="small upper muted">Есть ли лимиты?</h3>
      <p>Лимиты задаются настройками приложения, сетью, браузером и NAT/Firewall. Текущий лимит отображается при выборе файлов.</p>
      <h3 class="small upper muted">Можно ли отправлять несколько файлов?</h3>
      <p>Да. Отправляйте по очереди — интерфейс покажет прогресс каждой передачи, а несколько файлов можно объединить в ZIP.</p>
      <h3 class="small upper muted">Что происходит с выбранными файлами при перезагрузке?</h3>
      <p>Очередь сохраняется в IndexedDB этого браузера и восстанавливается при следующем открытии. Содержимое передаётся напрямую и на сервере не хранится.</p>
    </section>

    <section class="section glass fade-target" aria-labelledby="legal-title">
      <h2 id="legal-title" class="section-title">Юридическая информация</h2>

      <h3 class="small upper muted">Пользовательское соглашение</h3>
      <ul>
        <li><b>«Как есть»:</b> сервис предоставляется без гарантий бесперебойной работы и соответствия вашим задачам.</li>
        <li><b>Ответственность пользователя:</b> вы отвечаете за законность и безопасность передаваемых файлов.</li>
        <li><b>Доступность:</b> сервис может изменяться или прекращать работу без предварительного уведомления.</li>
        <li><b>Прекращение:</b> мы можем ограничить доступ при очевидном нарушении условий или высоком риске безопасности.</li>
      </ul>

      <h3 class="small upper muted">Политика конфиденциальности</h3>
      <ul>
        <li><b>Файлы не сохраняются</b> на сервере и не обрабатываются им.</li>
        <li><b>Технические данные</b> (IP, WebRTC ID, User‑Agent) используются только для установления соединения и не хранятся дольше, чем нужно.</li>
        <li><b>Передача третьим лицам</b> не осуществляется, за исключением случаев, предусмотренных законом.</li>
        <li><b>Локальные данные</b> (IndexedDB, localStorage) применяются для работы интерфейса и очереди файлов, не для отслеживания контента.</li>
      </ul>

      <h3 class="small upper muted">Согласие на обработку данных</h3>
      <p>Используя сайт, вы соглашаетесь на обработку минимального объёма технических данных, необходимых для P2P‑соединения.</p>

      <h3 class="small upper muted">Политика допустимого использования</h3>
      <ul>
        <li><b>Запрещено</b> передавать материалы, нарушающие законы, права третьих лиц, содержащие вредоносный код или ссылки на него.</li>
        <li><b>Запрещено</b> пытаться получить несанкционированный доступ к чужим устройствам или данным через сервис.</li>
      </ul>

      <h3 class="small upper muted">Отказ от ответственности</h3>
      <p>Twindrop не несёт ответственности за прямой или косвенный ущерб, включая утрату данных, утечки информации и иные последствия использования сервиса.</p>

      <h3 class="small upper muted">Cookies и LocalStorage</h3>
      <p>Мы используем только строго необходимые механизмы для корректной работы интерфейса. Вы можете ограничить их в настройках браузера, и это может повлиять на UX.</p>

      <h3 class="small upper muted">Возрастные ограничения</h3>
      <p>Сервис предназначен для пользователей старше 13 лет или с согласия законного представителя, если это требуется законодательством вашей страны.</p>

      <h3 class="small upper muted">Сообщить о нарушении</h3>
      <p>Если вы считаете, что через сервис распространяется незаконный контент, свяжитесь с нами — мы оперативно рассмотрим обращение.</p>

      <p class="small muted legal">
        Документ вступил в силу <time datetime="2025-09-01">1 сентября 2025</time> и остаётся действующим до публикации новой редакции.
        Мы можем обновлять условия использования и политику конфиденциальности без предварительного уведомления.
        Продолжение использования сервиса после выхода обновлённых условий означает ваше согласие с ними.
        Вопросы и предложения: <a href="mailto:twindrop.share@gmail.com" class="muted">twindrop.share@gmail.com</a>.
      </p>

      <p class="small muted legal">
        Версия сайта: <b>v3.0.0</b> — SPA на Vue 3 + Vite.
        обновлено: <time datetime="2026-10-24">24 октября 2026</time>
      </p>
    </section>

    <section class="section glass about-portfolio fade-target" aria-labelledby="portfolio-title">
      <div class="portfolio-card">
        <div class="portfolio-info">
          <h2 id="portfolio-title" class="portfolio-name">Jahongir</h2>
          <p class="portfolio-subtitle">Портфолио и проекты</p>
        </div>
        <a class="portfolio-link" href="https://jahongirdev.uz" target="_blank" rel="noopener noreferrer">
          jahongirdev.uz
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M7 17 17 7"></path>
            <path d="M8 7h9v9"></path>
          </svg>
        </a>
      </div>
    </section>
  </div>
</template>
