package com.llmwiki.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.llmwiki.ExternalEvent
import com.llmwiki.data.SupabaseClientProvider
import io.github.jan.supabase.auth.auth
import com.llmwiki.ui.auth.AuthScreen
import com.llmwiki.ui.settings.SettingsScreen
import com.llmwiki.ui.wiki.WikiScreen
import com.llmwiki.ui.workspace.WorkspaceCreateScreen

@Composable
fun LlmWikiNavGraph(
    shareUrlEvent: ExternalEvent? = null,
    authReturnEvent: ExternalEvent? = null,
) {
    val navController = rememberNavController()
    val initialAccountName = SupabaseClientProvider.client.auth.currentSessionOrNull()?.user?.email.orEmpty()
    val startDestination = if (initialAccountName.isNotBlank()) "wiki" else "auth"

    var accountName by rememberSaveable { mutableStateOf(initialAccountName) }

    NavHost(navController = navController, startDestination = startDestination) {
        composable("auth") {
            AuthScreen(
                onAuthenticated = { authState ->
                    accountName = authState.accountName
                    val wsId = authState.workspaceId
                    val route = if (wsId != null) "wiki?workspaceId=$wsId" else "workspace-create"
                    navController.navigate(route) {
                        popUpTo("auth") { inclusive = true }
                    }
                },
            )
        }
        composable(
            route = "wiki?workspaceId={workspaceId}",
            arguments = listOf(navArgument("workspaceId") {
                type = NavType.StringType
                nullable = true
                defaultValue = null
            }),
        ) { backStackEntry ->
            WikiScreen(
                workspaceId = backStackEntry.arguments?.getString("workspaceId"),
                accountName = accountName,
                shareUrl = shareUrlEvent?.value,
                authReturnUri = authReturnEvent?.value,
                onNavigateToSettings = { navController.navigate("settings") },
                onNavigateToCreateWorkspace = { navController.navigate("workspace-create") },
                onSignedOut = {
                    navController.navigate("auth") {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }
        composable("workspace-create") {
            WorkspaceCreateScreen(
                canNavigateBack = navController.previousBackStackEntry != null,
                authReturnUri = authReturnEvent?.value,
                onBack = { navController.popBackStack() },
                onWorkspaceCreated = { workspaceId ->
                    navController.navigate("wiki?workspaceId=$workspaceId") {
                        popUpTo("workspace-create") { inclusive = true }
                    }
                },
            )
        }
        composable("settings") {
            SettingsScreen(
                onBack = { navController.popBackStack() },
            )
        }
    }
}
