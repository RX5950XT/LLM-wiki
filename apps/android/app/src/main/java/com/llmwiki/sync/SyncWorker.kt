package com.llmwiki.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.llmwiki.data.DriveClient
import com.llmwiki.data.PageRepository
import com.llmwiki.data.SupabaseClientProvider
import com.llmwiki.data.room.AppDatabase
import io.github.jan.supabase.auth.auth
import java.util.concurrent.TimeUnit

class SyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val accountName = inputData.getString(KEY_ACCOUNT_NAME) ?: return Result.failure()
        val workspaceId = inputData.getString(KEY_WORKSPACE_ID) ?: return Result.failure()

        return try {
            val db = AppDatabase.getInstance(applicationContext)
            val drive = DriveClient(applicationContext, accountName)
            val repo = PageRepository(db, drive)
            repo.syncPages(workspaceId)
            Result.success()
        } catch (e: Exception) {
            // Retry on transient failures; the WorkManager back-off policy handles timing
            Result.retry()
        }
    }

    companion object {
        const val TAG = "LlmWikiSync"
        const val KEY_ACCOUNT_NAME = "accountName"
        const val KEY_WORKSPACE_ID = "workspaceId"

        /**
         * Enqueue a periodic background sync (once per hour while network is available).
         * Replaces any previously enqueued sync with the same unique name.
         */
        fun cancel(context: Context, workspaceId: String) {
            WorkManager.getInstance(context).cancelUniqueWork("$TAG/$workspaceId")
        }

        fun schedule(context: Context, accountName: String, workspaceId: String) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<SyncWorker>(1, TimeUnit.HOURS)
                .setConstraints(constraints)
                .setInputData(
                    workDataOf(
                        KEY_ACCOUNT_NAME to accountName,
                        KEY_WORKSPACE_ID to workspaceId,
                    )
                )
                .addTag(TAG)
                .build()

            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(
                    "$TAG/$workspaceId",
                    androidx.work.ExistingPeriodicWorkPolicy.KEEP,
                    request,
                )
        }
    }
}
