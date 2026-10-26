import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import RoomView from '../views/RoomView.vue';
import AboutView from '../views/AboutView.vue';

const routes = [
  {
    path: '/',
    name: 'home',
    component: HomeView,
    meta: {
      title: 'Twindrop — безопасная P2P-передача файлов',
      pageClass: 'page-home',
    },
  },
  {
    path: '/s',
    alias: ['/send'],
    name: 'join-room',
    component: RoomView,
    meta: {
      title: 'Подключиться к комнате | Twindrop',
      pageClass: 'page-join',
      roomMode: 'join',
    },
  },
  {
    path: '/r',
    alias: ['/receive'],
    name: 'create-room',
    component: RoomView,
    meta: {
      title: 'Создать комнату | Twindrop',
      pageClass: 'page-create',
      roomMode: 'create',
    },
  },
  {
    path: '/about',
    name: 'about',
    component: AboutView,
    meta: {
      title: 'О проекте | Twindrop',
      pageClass: 'page-about',
    },
  },
  {
    path: '/index.html',
    redirect: '/',
  },
  {
    path: '/send.html',
    redirect: (to) => ({ path: '/s', query: to.query, hash: to.hash }),
  },
  {
    path: '/receive.html',
    redirect: (to) => ({ path: '/r', query: to.query, hash: to.hash }),
  },
  {
    path: '/about.html',
    redirect: (to) => ({ path: '/about', query: to.query, hash: to.hash }),
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      return savedPosition;
    }

    if (to.hash) {
      return { el: to.hash, behavior: 'smooth' };
    }

    if (to.path === from.path) {
      return false;
    }

    return { top: 0 };
  },
});

router.afterEach((to) => {
  document.title = to.meta?.title || 'Twindrop — безопасная P2P-передача файлов';
});

export default router;
