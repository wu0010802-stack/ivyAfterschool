<script setup lang="ts">
// FRONTEND-063：參考資料頁（/settings/reference，settings:read）。
// 設計稿：docs/mockups/page-settings-reference.html。四個分頁各是一個自載入的表格元件（FRONTEND-059~062），
// el-tab-pane lazy：沒切到的分頁不掛載、不發請求。分頁存在 ?tab=（subjects / exam-types / schools / closed-days）。
// 寫入後的 lookups 快取失效由各表格元件負責，本頁不重複呼叫。
import type { TabPaneName } from 'element-plus'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/common/PageHeader.vue'
import ClosedDayTable from '@/components/settings/reference/ClosedDayTable.vue'
import ExamTypeTable from '@/components/settings/reference/ExamTypeTable.vue'
import SchoolTable from '@/components/settings/reference/SchoolTable.vue'
import SubjectTable from '@/components/settings/reference/SubjectTable.vue'

const TABS = [
  { name: 'subjects', label: '科目', component: SubjectTable },
  { name: 'exam-types', label: '考試類型', component: ExamTypeTable },
  { name: 'schools', label: '合作國小', component: SchoolTable },
  { name: 'closed-days', label: '休息日', component: ClosedDayTable },
] as const

const route = useRoute()
const router = useRouter()

const activeTab = computed(() => {
  const tab = route.query.tab
  return TABS.find((t) => t.name === tab)?.name ?? TABS[0].name
})

function onTabChange(name: TabPaneName): void {
  void router.replace({ query: { ...route.query, tab: String(name) } })
}
</script>

<template>
  <div class="reference-page">
    <PageHeader
      title="參考資料"
      subtitle="科目、考試類型、合作國小與休息日"
    />

    <section class="reference-page__panel">
      <el-tabs
        class="reference-page__tabs"
        :model-value="activeTab"
        @update:model-value="onTabChange"
      >
        <el-tab-pane
          v-for="t in TABS"
          :key="t.name"
          :name="t.name"
          :label="t.label"
          lazy
        >
          <component :is="t.component" />
        </el-tab-pane>
      </el-tabs>
    </section>
  </div>
</template>

<style scoped>
.reference-page__panel {
  padding: 4px 16px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.reference-page__tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}
</style>
