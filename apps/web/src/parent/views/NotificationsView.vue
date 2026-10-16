<script setup lang="ts">
// PARENT-012 佔位檔（不含業務邏輯、不是 UI 實作），由 PARENT-177 的 NotificationsView 直接覆寫。
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <main data-placeholder="NotificationsView">
    <h1>{{ route.meta.title }}</h1>
  </main>
</template>
