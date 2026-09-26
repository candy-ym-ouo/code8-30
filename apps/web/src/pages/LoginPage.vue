<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import ErrorNotice from '../components/ErrorNotice.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const email = ref('');
const password = ref('');
const error = ref('');
const fields = ref<Record<string, string>>({});
const loading = ref(false);
const schema = z.object({
  email: z.string().email('请输入有效邮箱'),
  password: z.string().min(8, '密码至少 8 位')
});

async function submit(): Promise<void> {
  error.value = '';
  fields.value = {};
  const parsed = schema.safeParse({ email: email.value, password: password.value });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) fields.value[String(issue.path[0])] = issue.message;
    return;
  }
  loading.value = true;
  try {
    await auth.login(parsed.data.email, parsed.data.password);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push(redirect);
  } catch (caught) {
    if (caught instanceof ApiError) {
      error.value = caught.message;
      fields.value = caught.fields ?? {};
    } else error.value = '登录失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-copy">
      <p class="eyebrow">PAPER BOOK TRACES</p>
      <h1>把书页里的停留，留在书页之外。</h1>
      <p>这里没有阅读速度。只有你在哪一页折过角、写下过什么，以及读完后为什么沉默。</p>
    </section>
    <form class="card auth-card" @submit.prevent="submit">
      <h2>登录</h2>
      <div v-if="route.query.reason === 'credentials_changed'" class="success-notice" role="status">
        密码已在其他设备修改，请使用最新密码重新登录。
      </div>
      <ErrorNotice :message="error" :fields="fields" />
      <label>
        邮箱
        <input v-model="email" type="email" autocomplete="email" required />
      </label>
      <label>
        密码
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <button class="button button-primary button-block" type="submit" :disabled="loading">
        {{ loading ? '正在登录…' : '登录' }}
      </button>
      <p class="form-footnote">还没有账号？<RouterLink to="/register">创建个人档案</RouterLink></p>
    </form>
  </main>
</template>
