package org.bungee.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.DnsResolver
import android.os.Build
import android.os.CancellationSignal
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import java.util.concurrent.Executor
import kotlin.coroutines.resume

/** DNS monitoring has no dependency on GPS, camera permissions, or Android's VPN slot. */
class PrivateDnsService : Service() {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main)
    private var worker:Job?=null
    private val owner=Any()
    @Volatile private var reportOff=false
    override fun onBind(intent:Intent?)=null
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        if(intent?.action=="REPORT_OFF")reportOff=true
        if(worker?.isActive==true)return START_STICKY
        val nm=getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("dns","Private DNS protection",NotificationManager.IMPORTANCE_LOW))
        val open=PendingIntent.getActivity(this,16,Intent(this,MainActivity::class.java),PendingIntent.FLAG_IMMUTABLE)
        val notification=NotificationCompat.Builder(this,"dns").setSilent(true).setOnlyAlertOnce(true).setSmallIcon(R.drawable.ic_bungee).setContentTitle("Bungee DNS monitor")
            .setContentText("Checks DNS and restores normal DNS when fallback is enabled").setContentIntent(open).setOngoing(true).build()
        try {startForeground(16,notification,if(Build.VERSION.SDK_INT>=34)ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)}
        catch(_:RuntimeException){runCatching { PrivateDns.interrupted(this) };stopSelf();return START_NOT_STICKY}
        worker=scope.launch {
            var failures=0;var changedAt=SystemClock.elapsedRealtime();var lastHost="";var nextSync=0L
            while(isActive){
                if(LocalSafety.isStopped(this@PrivateDnsService)){
                    runCatching { PrivateDns.disable(this@PrivateDnsService) };stopSelf();break
                }
                if(reportOff||SystemClock.elapsedRealtime()>=nextSync){
                    reportOff=false
                    nextSync=SystemClock.elapsedRealtime()+30_000
                    runCatching {withContext(Dispatchers.IO){
                        val identity=Identity(this@PrivateDnsService)
                        if(identity.enrolled){
                            HomeTunnel.connect(this@PrivateDnsService,identity,org.json.JSONObject(identity.bundle!!),owner,claimExisting=false)
                            try {
                                val api=HomeApi(identity)
                                val result=api.request("/v1/private-dns",PrivateDns.report(this@PrivateDnsService))
                                PrivateDns.apply(this@PrivateDnsService,result.getJSONObject("dns"))
                                if(!PrivateDns.state(this@PrivateDnsService).consent){
                                    val acknowledged=api.request("/v1/private-dns",PrivateDns.report(this@PrivateDnsService))
                                    PrivateDns.apply(this@PrivateDnsService,acknowledged.getJSONObject("dns"))
                                }
                            }
                            finally {HomeTunnel.disconnectOwned(owner)}
                        }
                    }}
                }
                val s=runCatching {PrivateDns.state(this@PrivateDnsService)}.getOrNull()
                if(s==null){runCatching {PrivateDns.interrupted(this@PrivateDnsService)};stopSelf();break}
                if(s.hostname!=lastHost){lastHost=s.hostname;changedAt=SystemClock.elapsedRealtime();failures=0}
                val cm=getSystemService(ConnectivityManager::class.java)
                if(s.owned&&s.status=="active"&&(cm.activeNetwork!=null||cm.allNetworks.isNotEmpty())&&SystemClock.elapsedRealtime()-changedAt>=30_000){
                    val healthy=probe()
                    failures=if(healthy)0 else failures+1
                    if(failures>=3&&s.fallback){runCatching { val current=PrivateDns.state(this@PrivateDnsService);if(current.hostname==s.hostname&&current.revision==s.revision)PrivateDns.failed(this@PrivateDnsService) };failures=0}
                }
                // Retain the monitor during a remote Off so a subsequent On can arrive. Local Off ends consent.
                if(!s.consent&&!s.owned){stopSelf();break}
                delay(10_000)
            }
        }
        return START_STICKY
    }
    private suspend fun probe():Boolean = withTimeoutOrNull(5_000){
        suspendCancellableCoroutine { continuation ->
            val signal=CancellationSignal();continuation.invokeOnCancellation { signal.cancel() }
            val cm=getSystemService(ConnectivityManager::class.java)
            val network=cm.activeNetwork
            val properties=network?.let(cm::getLinkProperties)
            val wanted=runCatching {PrivateDns.state(this@PrivateDnsService).hostname}.getOrNull()
            if(network==null||properties?.isPrivateDnsActive!=true||properties.privateDnsServerName!=wanted){continuation.resume(false);return@suspendCancellableCoroutine}
            try {
                DnsResolver.getInstance().query(network,"example.com",DnsResolver.FLAG_NO_CACHE_LOOKUP,
                    Executor { it.run() },signal,object:DnsResolver.Callback<List<java.net.InetAddress>>{
                        override fun onAnswer(answer:List<java.net.InetAddress>,rcode:Int){if(continuation.isActive)continuation.resume(rcode==0||rcode==3||rcode==5)}
                        override fun onError(error:DnsResolver.DnsException){if(continuation.isActive)continuation.resume(false)}
                    })
            }catch(_:Exception){if(continuation.isActive)continuation.resume(false)}
        }
    }?:false
    override fun onDestroy(){
        worker?.cancel();scope.cancel()
        // Best effort; process death cannot execute this hook. Startup recovery handles a later restart.
        runCatching {PrivateDns.interrupted(this)}
        super.onDestroy()
    }
    companion object {
        fun reportOff(context:Context){ContextCompat.startForegroundService(context,Intent(context,PrivateDnsService::class.java).setAction("REPORT_OFF"))}
        fun start(context:Context){ContextCompat.startForegroundService(context,Intent(context,PrivateDnsService::class.java))}
    }
}
