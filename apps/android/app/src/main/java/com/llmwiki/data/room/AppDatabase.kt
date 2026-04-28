package com.llmwiki.data.room

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [PageEntity::class], version = 3, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {

    abstract fun pageDao(): PageDao

    companion object {
        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    "ALTER TABLE pages ADD COLUMN account_name TEXT NOT NULL DEFAULT ''"
                )
            }
        }

        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    """
                    CREATE TABLE pages_new (
                        workspace_id TEXT NOT NULL,
                        account_name TEXT NOT NULL,
                        slug TEXT NOT NULL,
                        title TEXT,
                        content TEXT,
                        version INTEGER NOT NULL,
                        drive_file_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        updated_by TEXT NOT NULL,
                        locked_by_human INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY(workspace_id, account_name, slug)
                    )
                    """.trimIndent()
                )
                database.execSQL(
                    """
                    INSERT INTO pages_new (
                        workspace_id,
                        account_name,
                        slug,
                        title,
                        content,
                        version,
                        drive_file_id,
                        kind,
                        updated_at,
                        updated_by,
                        locked_by_human
                    )
                    SELECT
                        workspace_id,
                        account_name,
                        slug,
                        title,
                        content,
                        version,
                        drive_file_id,
                        kind,
                        updated_at,
                        updated_by,
                        locked_by_human
                    FROM pages
                    WHERE account_name != ''
                    """.trimIndent()
                )
                database.execSQL("DROP TABLE pages")
                database.execSQL("ALTER TABLE pages_new RENAME TO pages")
            }
        }

        @Volatile
        private var instance: AppDatabase? = null

        fun getInstance(context: Context): AppDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "llmwiki.db",
                )
                    .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { instance = it }
            }
    }
}
