<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import { authApi, exportApi } from '../api';
import { useAuthStore } from '../stores/auth';
import ErrorNotice from '../components/ErrorNotice.vue';

const auth = useAuthStore();
const router = useRouter();
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const deletePassword = ref('');
const includeDeleted = ref(false);
const error = ref('');
const success = ref('');
const saving = ref(false);

// 凭证已在其他设备被更新：本设备会话已经失效，清理本地登录态并要求重新登录。
function isStaleCredential(caught: unknown): boolean {
  return caught instanceof ApiError && (caught.code === 'CREDENTIALS_CHANGED' || caught.status === 401);
}

async function changePassword(): Promise<void> {
  error.value = '';
  success.value = '';
  if (newPassword.value.length < 8) {
    error.value = '新密码至少 8 位';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致';
    return;
  }
  saving.value = true;
  try {
    await authApi.password(currentPassword.value, newPassword.value);
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    success.value = '密码已修改，其他设备上的登录状态已失效';
  } catch (caught) {
    if (isStaleCredential(caught)) {
      auth.user = null;
      await router.push({ path: '/login', query: { reason: 'credentials_changed' } });
      return;
    }
    error.value = caught instanceof ApiError ? caught.message : '密码修改失败';
  } finally {
    saving.value = false;
  }
}

async function exportData(): Promise<void> {
  error.value = '';
  try {
    const blob = await exportApi.download(includeDeleted.value);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `paper-book-traces-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    success.value = '个人数据导出已开始下载';
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '导出失败';
  }
}

async function deleteAccount(): Promise<void> {
  error.value = '';
  if (!window.confirm('注销后当前账号将无法登录，所有书目和痕迹会保留在软删除状态。确定继续吗？')) return;
  try {
    await authApi.deleteAccount(deletePassword.value);
    auth.user = null;
    await router.push('/login');
  } catch (caught) {
    if (isStaleCredential(caught)) {
      auth.user = null;
      await router.push({ path: '/login', query: { reason: 'credentials_changed' } });
      return;
    }
    error.value = caught instanceof ApiError ? caught.message : '注销失败';
  }
}
</script>

<template>
  <section class="narrow-section">
    <header class="page-heading">
      <div>
        <p class="eyebrow">YOUR DATA</p>
        <h1>设置</h1>
        <p>管理账号、导出个人档案，或停止使用这项服务。</p>
      </div>
    </header>
    <ErrorNotice :message="error" />
    <div v-if="success" class="success-notice" role="status">{{ success }}</div>

    <section class="card settings-section">
      <div>
        <h2>账号</h2>
        <p class="muted">{{ auth.user?.email }}</p>
        <p class="muted">注册于 {{ new Date(auth.user?.createdAt ?? '').toLocaleDateString('zh-CN') }}</p>
      </div>
      <form class="form-stack" @submit.prevent="changePassword">
        <h3>修改密码</h3>
        <label>当前密码<input v-model="currentPassword" type="password" autocomplete="current-password" required /></label>
        <label>新密码<input v-model="newPassword" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label>确认新密码<input v-model="confirmPassword" type="password" autocomplete="new-password" required /></label>
        <button class="button button-primary" type="submit" :disabled="saving">修改密码</button>
      </form>
    </section>

    <section class="card settings-section">
      <div>
        <h2>导出我的数据</h2>
        <p>下载 JSON 档案，包含书目、阅读痕迹、完成感受和完整时间线。密码与会话信息不会导出。</p>
        <label class="checkbox-label">
          <input v-model="includeDeleted" type="checkbox" />
          同时包含软删除的历史对象
        </label>
      </div>
      <button class="button button-primary" type="button" @click="exportData">导出我的数据</button>
    </section>

    <section class="card settings-section danger-zone">
      <div>
        <h2>注销账号</h2>
        <p>账号会停止可访问，已有数据保留在服务端软删除状态。此操作不可在界面中撤销。</p>
        <label>输入密码确认<input v-model="deletePassword" type="password" required /></label>
      </div>
      <button class="button button-danger" type="button" @click="deleteAccount">注销账号</button>
    </section>
  </section>
</template>
