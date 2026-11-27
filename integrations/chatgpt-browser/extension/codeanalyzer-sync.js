// Fixed-origin content script. Pull only while the CodeAnalyzer dashboard
// has installed its receiver. Reports never travel over a network request.
(() => {
  const ORIGIN="https://id-preview--61bac7b4-3733-42bd-b6db-4b02173d15f2.lovable.app";
  if(location.origin!==ORIGIN||window.top!==window)return;
  let previous=null,inFlight=false,receiver=null;
  async function sync(){
    if(inFlight)return;
    const marker=document.querySelector('[data-codeanalyzer-import="v1"][data-codeanalyzer-ready="v1"]');
    if(!marker){receiver=null;previous=null;return;}
    if(receiver!==marker){receiver=marker;previous=null;}
    inFlight=true;
    try{
      const response=await chrome.runtime.sendMessage({type:"codeAnalyzerReadLatest"});
      if(!response?.ok||!marker.isConnected)return;
      const report=response.report;
      if(!report){if(previous!==null)window.postMessage({type:"CODEANALYZER_REPORT_CLEARED_V1"},ORIGIN);previous=null;return;}
      if(typeof report.id!=="string"||typeof report.raw!=="string"||previous===report.id)return;
      window.postMessage({type:"CODEANALYZER_REPORT_V1",mode:"extension-local",raw:report.raw,requestId:report.id},ORIGIN);
      // Only acknowledge delivery when the dashboard schema parser accepts it.
      // Retry if the receiver is not ready; never count a post as a receipt.
      if(marker.getAttribute("data-codeanalyzer-ack")===report.id)previous=report.id;
      else {
        await new Promise(resolve=>setTimeout(resolve,100));
        if(marker.getAttribute("data-codeanalyzer-ack")===report.id)previous=report.id;
      }
    }catch{ /* Extension reload or a closed dashboard; retry on next tick. */ }
    finally{inFlight=false;}
  }
  void sync();setInterval(sync,1500);
})();
