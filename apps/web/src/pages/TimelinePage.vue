<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { booksApi, timelineApi } from '../api';
import { formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import {
  ACTION_LABELS,
  ENTITY_LABELS,
  MOOD_LABELS,
  type ActivityAction,
  type ActivityEntityType,
  type Book,
  type MoodTag,
  type TimelineEvent
} from '../types/domain';

const events = ref<TimelineEvent[]>([]);
const books = ref<Book[]>([]);
const loading = ref(true);
const error = ref('');
const bookId = ref('');
const action = ref<'ALL' | ActivityAction>('ALL');
const entityType = ref<'ALL' | ActivityEntityType>('ALL');
const from = ref('');
const to = ref('');
const page = ref(1);
const pageSize = 30;
const total = ref(0);

function params(): URLSearchParams {
  const value = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) });
  if (bookId.value) value.set('bookId', bookId.value);
  if (action.value !== 'ALL') value.set('eventType', action.value);
  if (entityType.value !== 'ALL') value.set('entityType', entityType.value);
  if (from.value) value.set('from', new Date(`${from.value}T00:00:00`).toISOString());
  if (to.value) value.set('to', new Date(`${to.value}T23:59:59.999`).toISOString());
  return value;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await timelineApi.list(params());
    events.value = result.items;
    total.value = result.pagination.total;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '时间线加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadBooks(): Promise<void> {
  try {
    const result = await booksApi.list(new URLSearchParams({ page: '1', pageSize: '100' }));
    books.value = result.items;
  } catch {
    books.value = [];
  }
}

function filter(): void {
  page.value = 1;
  void load();
}

function summary(event: TimelineEvent): string {
  const payload = event.payload;
  if (event.action === 'PASSWORD_CHANGED') return '其他设备的登录状态已失效';
  if (typeof payload.pageNumber === 'number') return `第 ${payload.pageNumber} 页`;
  if (typeof payload.startPage === 'number') {
    return `第 ${payload.startPage}–${typeof payload.endPage === 'number' ? payload.endPage : payload.startPage} 页`;
  }
  if (Array.isArray(payload.moodTags)) {
    return payload.moodTags.map((tag) => MOOD_LABELS[tag as MoodTag] ?? tag).join('、');
  }
  if (typeof payload.previousStatus === 'string' && typeof payload.nextStatus === 'string') {
    return `${payload.previousStatus} → ${payload.nextStatus}`;
  }
  if (typeof payload.summary === 'string') return payload.summary;
  return '';
}

onMounted(async () => {
  await Promise.all([loadBooks(), load()]);
});
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <p class="eyebrow">TIME, NOT SPEED</p>
        <h1>时间线</h1>
        <p>不是阅读进度，而是这些书在什么时刻发生过变化。</p>
      </div>
    </header>

    <form class="card filter-grid" @submit.prevent="filter">
      <label>
        书目
        <select v-model="bookId">
          <option value="">全部书目</option>
          <option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option>
        </select>
      </label>
      <label>
        动作
        <select v-model="action">
          <option value="ALL">全部</option>
          <option v-for="(label, value) in ACTION_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>
        对象
        <select v-model="entityType">
          <option value="ALL">全部</option>
          <option v-for="(label, value) in ENTITY_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>开始日期<input v-model="from" type="date" /></label>
      <label>结束日期<input v-model="to" type="date" /></label>
      <button class="button button-primary" type="submit">筛选</button>
    </form>

    <ErrorNotice :message="error" />
    <div v-if="loading" class="state-panel">正在整理时间线…</div>
    <div v-else-if="events.length === 0" class="empty-state card">
      <h2>这个范围内还没有变化</h2>
      <p>创建书目或留下第一处阅读痕迹后，时间会从这里开始。</p>
    </div>
    <div v-else class="timeline-page-list">
      <article v-for="event in events" :key="event.id" class="timeline-item card">
        <span class="timeline-dot" aria-hidden="true" />
        <div class="timeline-content">
          <div class="timeline-heading">
            <strong>{{ ACTION_LABELS[event.action] }} · {{ ENTITY_LABELS[event.entityType] }}</strong>
            <time :datetime="event.occurredAt">{{ formatDateTime(event.occurredAt) }}</time>
          </div>
          <p>
            <RouterLink v-if="event.bookId" :to="`/books/${event.bookId}`">{{ event.bookTitle }}</RouterLink>
            <span v-else-if="event.entityType === 'USER'">账号安全</span>
            <span v-else>{{ event.bookTitle }}</span>
            <span v-if="summary(event)"> · {{ summary(event) }}</span>
          </p>
        </div>
      </article>
    </div>

    <nav v-if="total > pageSize" class="pagination" aria-label="时间线分页">
      <button class="button button-quiet" :disabled="page <= 1" @click="page--; load()">上一页</button>
      <span>第 {{ page }} 页，共 {{ Math.ceil(total / pageSize) }} 页</span>
      <button class="button button-quiet" :disabled="page >= Math.ceil(total / pageSize)" @click="page++; load()">下一页</button>
    </nav>
  </section>
</template>
