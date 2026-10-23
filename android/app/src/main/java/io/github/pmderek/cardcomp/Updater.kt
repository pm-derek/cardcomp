package io.github.pmderek.cardcomp

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.widget.Toast
import java.io.File

/**
 * Installs a downloaded APK over this app with the platform PackageInstaller (no browser, no file manager).
 * Android asks Derek to confirm; an update only installs when it is signed with the same key as the installed app,
 * so builds signed with the repo keystore secret update in place (android/README.md).
 */
object Updater {
    fun install(ctx: Context, apk: File) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            apk.inputStream().use { inp ->
                s.openWrite("base.apk", 0, apk.length()).use { out -> inp.copyTo(out); s.fsync(out) }
            }
            val intent = Intent(ctx, InstallReceiver::class.java)
            // mutable: the installer adds the status and the confirm intent to it
            val pending = PendingIntent.getBroadcast(ctx, id, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            s.commit(pending.intentSender)
        }
    }
}

class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try { ctx.startActivity(confirm) } catch (e: Exception) { toast(ctx, "could not open the installer: ${e.message}") }
            }
            PackageInstaller.STATUS_SUCCESS -> toast(ctx, "CardComp updated")
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                toast(ctx, "update signed with a different key: uninstall CardComp once and install the new build by hand")
            PackageInstaller.STATUS_FAILURE_ABORTED -> toast(ctx, "update cancelled")
            else -> toast(ctx, "update failed: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown"}")
        }
    }
    private fun toast(ctx: Context, t: String) = Toast.makeText(ctx, t, Toast.LENGTH_LONG).show()
}
