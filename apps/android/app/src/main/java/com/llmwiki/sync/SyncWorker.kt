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
import com.llmwiki.data.room.AppDatabase
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
            repo.syncPages(workspaceId, accountName)
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

        fun cancel(context: Context, accountName: String, workspaceId: String) {
            WorkManager.getInstance(context).cancelUniqueWork(uniqueWorkName(accountName, workspaceId))
            WorkManager.getInstance(context).cancelUniqueWork(legacyWorkName(workspaceId))
        }

        fun schedule(context: Context, accountName: String, workspaceId: String) {
            WorkManager.getInstance(context).cancelUniqueWork(legacyWorkName(workspaceId))
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
                    uniqueWorkName(accountName, workspaceId),
                    androidx.work.ExistingPeriodicWorkPolicy.KEEP,
                    request,
                )
        }

        private fun uniqueWorkName(accountName: String, workspaceId: String) =
            "$TAG/$accountName/$workspaceId"

        private fun legacyWorkName(workspaceId: String) = "$TAG/$workspaceId"
    }
}
