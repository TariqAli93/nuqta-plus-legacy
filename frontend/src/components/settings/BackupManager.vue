<script setup>
import { ref, onMounted } from 'vue';
import api from '@/plugins/axios';
import { useRouter } from 'vue-router';
import { useSimpleLoading } from '@/composables/useLoading';
import { useNotificationStore } from '@/stores/notification';

const router = useRouter();
const notification = useNotificationStore();

const backups = ref([]);
const { isLoading, startLoading, stopLoading } = useSimpleLoading();

const createBackup = async () => {
  startLoading();
  try {
    await api.post('/settings/backups', {});
    notification.success('تم إنشاء النسخة الاحتياطية بنجاح');
    await load();
  } catch {
    notification.error('فشل في إنشاء النسخة الاحتياطية');
  } finally {
    stopLoading();
  }
};

const load = async () => {
  startLoading();
  try {
    const response = await api.get('/settings/backups');
    backups.value = response.data;
  } catch {
    notification.error('فشل في تحميل قائمة النسخ الاحتياطية');
  } finally {
    stopLoading();
  }
};

const deleteBackup = async (filename) => {
  startLoading();
  try {
    await api.delete(`/settings/backups/${filename}`);
    notification.success('تم حذف النسخة الاحتياطية بنجاح');
    await load();
  } catch {
    notification.error('فشل في حذف النسخة الاحتياطية');
  } finally {
    stopLoading();
  }
};

const restoreBackup = async (filename) => {
  if (
    !confirm(
      'هل أنت متأكد من استعادة هذه النسخة؟ سيتم فقدان أي بيانات تم إدخالها بعد تاريخ النسخة.'
    )
  )
    return;
  startLoading();
  try {
    const response = await window.electronAPI.restoreBackup(filename);
    if (response.ok) {
      notification.success('تم استعادة النسخة الاحتياطية بنجاح');
      // إعادة تحميل التطبيق بعد الاستعادة
      setTimeout(() => {
        window.location.reload();
        router.push('/');
      }, 2000);
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    notification.error('فشل في استعادة النسخة الاحتياطية: ' + error.message);
  } finally {
    stopLoading();
  }
};

const exportBackup = async (filename) => {
  try {
    const response = await window.electronAPI.exportBackup(filename);
    if (response.ok) {
      notification.success('تم تصدير النسخة الاحتياطية بنجاح');
    } else if (response.reason !== 'canceled') {
      throw new Error(response.error);
    }
  } catch (error) {
    notification.error('فشل في تصدير النسخة الاحتياطية: ' + error.message);
  }
};

const toYmd = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const headers = [
  { title: 'اسم الملف', value: 'filename' },
  { title: 'الحجم', value: 'sizeReadable' },
  { title: 'تاريخ الإنشاء', value: 'createdAt' },
  { title: 'الإجراء', value: 'actions', sortable: false },
];

const exportAndCreateNewDatabase = async () => {
  if (
    !confirm(
      'هل أنت متأكد من تصدير قاعدة البيانات الحالية وإنشاء قاعدة بيانات جديدة؟ سيتم تسجيل خروجك من التطبيق.'
    )
  )
    return;
  startLoading();
  try {
    const response = await window.electronAPI.exportAndCreateNewDatabase();
    if (response.ok) {
      notification.success('تم تصدير قاعدة البيانات وإنشاء قاعدة بيانات جديدة بنجاح');
      // تسجيل الخروج وإعادة تشغيل التطبيق
      await window.electronAPI.logoutAndRestart();
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    notification.error('فشل في تصدير قاعدة البيانات وإنشاء قاعدة بيانات جديدة: ' + error.message);
  } finally {
    stopLoading();
  }
};

onMounted(async () => {
  await load();
});
</script>

<template>
  <v-card elevation="0">
    <v-card-title class="d-flex align-center justify-space-between">
      <div class="text-h6 font-weight-bold">📦 إدارة نسخ قاعدة البيانات الاحتياطية</div>
      <div>
        <v-btn
          color="primary"
          variant="elevated"
          prepend-icon="mdi-database-export-outline"
          @click="createBackup"
        >
          إنشاء نسخة احتياطية
        </v-btn>

        <v-btn
          color="secondary"
          class="mr-3"
          variant="elevated"
          prepend-icon="mdi-database-plus-outline"
          @click="exportAndCreateNewDatabase"
          >تصدير و إنشاء قاعدة بيانات جديدة</v-btn
        >
      </div>
    </v-card-title>

    <v-divider class="my-3"></v-divider>

    <v-card-text>
      <v-skeleton-loader v-if="isLoading" type="table" class="mx-auto" />

      <v-alert v-else-if="backups.length === 0" type="info" variant="tonal" class="text-center">
        لا توجد نسخ احتياطية حتى الآن.
      </v-alert>

      <v-data-table v-else :headers="headers" :items="backups">
        <template #[`item.createdAt`]="{ item }">
          {{ toYmd(item.createdAt) }}
        </template>

        <template #[`item.actions`]="{ item }">
          <v-btn icon small color="error" variant="text" @click="deleteBackup(item.filename)">
            <v-icon>mdi-delete</v-icon>
          </v-btn>

          <v-btn icon small color="error" variant="text" @click="restoreBackup(item.filename)">
            <v-icon>mdi-restore</v-icon>
          </v-btn>

          <v-btn icon small color="primary" variant="text" @click="exportBackup(item.filename)">
            <v-icon>mdi-export</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card-text>

    <v-divider class="my-3"></v-divider>

    <v-card-actions>
      <v-btn variant="outlined" prepend-icon="mdi-refresh" color="primary" @click="load">
        تحديث القائمة
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped></style>
