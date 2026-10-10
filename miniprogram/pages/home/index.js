const { loadSave, writeSave } = require('../../core/save');
const { buildJourney, chapterDestination } = require('../../core/journey');
const { regions } = require('../../content/atlas');
const sound = require('../../core/sound');
const tabs = [
  {id:'explore',label:'探索',icon:'compass'},
  {id:'discoveries',label:'我的发现',icon:'journal-bookmark'},
  {id:'atlas',label:'科学图鉴',icon:'collection'},
  {id:'journey',label:'我的旅程',icon:'person'},
];
Page({
  data: {tabs,regions,activeTab:'explore',muted:false,continueLabel:'开始探索',discoveries:[],atlas:[],steps:[],progress:0,completedSteps:0,showInvitation:false,selectedCard:null,leaving:false,headerTop:70},
  onLoad() {
    const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync();
    const capsule=wx.getMenuButtonBoundingClientRect?wx.getMenuButtonBoundingClientRect():null;
    this.setData({headerTop:capsule?capsule.bottom+15:(info.statusBarHeight||24)+48});
  },
  onShow() {this.setData({...buildJourney(loadSave(wx)),muted:sound.isMuted(),leaving:false});},
  onHide() { if(this._transition)clearTimeout(this._transition); },
  onUnload() { if(this._transition)clearTimeout(this._transition); sound.destroy(); },
  switchTab(e) {sound.startBgm();sound.play('tap');this.setData({activeTab:e.currentTarget.dataset.tab,selectedCard:null});},
  startChapter() {
    sound.startBgm();sound.play('tap');
    const save=loadSave(wx);
    if(!save.completed&&!save.inspectedObjects.length&&!save.observations.length&&!save.companionEventsSeen.includes('world-invitation'))this.setData({showInvitation:true});
    else this.travelTo(chapterDestination(save));
  },
  enterChapter() {
    const save=loadSave(wx);
    if(!save.companionEventsSeen.includes('world-invitation'))save.companionEventsSeen.push('world-invitation');
    save.stage='investigate';writeSave(wx,save);this.setData({showInvitation:false});this.travelTo('/pages/study/index');
  },
  closeInvitation() {this.setData({showInvitation:false});},
  travelTo(url) {
    if(this.data.leaving)return;
    this.setData({leaving:true});
    this._transition=setTimeout(()=>{this._transition=null;wx.navigateTo({url,fail:()=>{this.setData({leaving:false});wx.showToast({title:'请再试一次',icon:'none'});}});},320);
  },
  openDiscovery(e) {sound.play('tap');this.travelTo('/pages/notebook/index?observation='+encodeURIComponent(e.currentTarget.dataset.id));},
  openAtlas(e) {const selectedCard=this.data.atlas.find(x=>x.id===e.currentTarget.dataset.id);this.setData({selectedCard});},
  openRegion(e) {this.setData({selectedCard:{...regions.find(x=>x.id===e.currentTarget.dataset.id),unlocked:true,status:'未来的探索'}});},
  closeCard() {this.setData({selectedCard:null});},
  openExperiment() {
    const item=this.data.selectedCard;if(!item||!item.unlocked||!item.mode)return;
    const save=loadSave(wx);
    if(!save.currentHypothesis){this.setData({selectedCard:null});this.startChapter();return;}
    save.apparatus={...save.apparatus,mode:item.mode,prism2InPath:false,lensInPath:false,blockedBands:[],slitWidth:item.mode==='selective_refraction'?.12:1,selectedBand:item.mode==='selective_refraction'?'red':null};
    writeSave(wx,save);this.setData({selectedCard:null});this.travelTo('/pages/lab/index');
  },
  viewArchive() {this.travelTo('/pages/ending/index');},
  toggleSound() {this.setData({muted:sound.toggleMuted()});},
  stopTap() {},
});
