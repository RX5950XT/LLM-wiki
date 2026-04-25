package com.llmwiki.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class SyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // TODO: Phase 3 — pull pending Drive changes and push local edits
        return Result.success()
    }

    companion object {
        const val TAG = "LlmWikiSync"
    }
}
