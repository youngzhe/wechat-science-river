const { BANDS, simulateOptics } = require('./optics');
const COLORS = {red:'#df6050',orange:'#f19a40',yellow:'#dfbf42',green:'#58a26b',blue:'#518dcc',violet:'#9271b3'};
function sceneGeometry(a, w, h) {
  const cy = h * .46, prismX = w * .22, slitX = w * .40, secondX = w * .52, lensX = w * .50;
  const screenX = w * (.18 + a.screenPosition * .82), focusX = w * (.18 + .62 * .82);
  const result = simulateOptics(a), rays = [];
  const selected = a.mode === 'selective_refraction' && BANDS.includes(a.selectedBand) && a.slitWidth <= .25;
  const inPath = a.prism1InPath && a.prism1Angle >= 18 && a.prism1Angle <= 48;
  if (inPath) {
    const bands = selected ? [a.selectedBand] : BANDS;
    bands.filter(b => !(a.blockedBands || []).includes(b)).forEach(band => {
      const index = BANDS.indexOf(band), spread = (index - 2.5) * h * .085;
      let points;
      if (selected) {
        points = [{x:prismX+12,y:cy},{x:slitX,y:cy-9}];
        if (a.prism2InPath) {
          points.push({x:secondX,y:cy-9});
          points.push({x:screenX,y:cy-9-(screenX-secondX)*.32});
        } else points.push({x:screenX,y:cy-9});
      } else if (a.mode === 'recombination' && a.lensInPath) {
        points = [{x:prismX+12,y:cy},{x:lensX,y:cy+spread}];
        points.push({x:screenX,y:cy+spread*(focusX-screenX)/(focusX-lensX)});
      } else points = [{x:prismX+12,y:cy},{x:screenX,y:cy+spread+result.pathOffset}];
      // A screen placed before an apparatus intercepts the incident segment.
      const clipped = [points[0]];
      for (let i=1;i<points.length;i++) {
        const prev=points[i-1], point=points[i];
        if (prev.x >= screenX) break;
        if (point.x >= screenX) { const t=(screenX-prev.x)/(point.x-prev.x); clipped.push({x:screenX,y:prev.y+(point.y-prev.y)*t}); break; }
        clipped.push(point);
      }
      if (clipped.length > 1) rays.push({band, color:COLORS[band], points:clipped});
    });
  }
  return { cy, prismX, slitX, secondX, lensX, screenX, focusX, rays, result, selected };
}
function paintOpticsScene(ctx, w, h, a) {
  const g = sceneGeometry(a,w,h), {cy,prismX,slitX,secondX,lensX,screenX,result} = g;
  ctx.fillStyle='#f6f0e3';ctx.fillRect(0,0,w,h);
  ctx.lineCap='round';ctx.font='11px sans-serif';ctx.textAlign='center';
  const line=(points,color,width=3)=>{ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();};
  const label=(x,text)=>{ctx.fillStyle='#63746d';ctx.fillText(text,x,h-15);};
  const prism=(x,y,angle)=>{ctx.save();ctx.translate(x,y);ctx.rotate(angle*Math.PI/180);ctx.beginPath();ctx.moveTo(-13,22);ctx.lineTo(0,-24);ctx.lineTo(14,22);ctx.closePath();ctx.fillStyle='rgba(112,181,191,.32)';ctx.fill();ctx.strokeStyle='#527f88';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();};
  ctx.fillStyle='#ba9462';ctx.fillRect(w*.035,cy-12,9,24);label(w*.05,'白光');
  line([{x:w*.06,y:cy},{x:a.prism1InPath?prismX:screenX,y:cy}],'#e9c975',5);
  g.rays.forEach(ray=>line(ray.points,ray.color,3));
  if(a.prism1InPath) prism(prismX,cy,a.prism1Angle-30);
  label(prismX,a.prism1InPath?'第一棱镜':'棱镜位置');
  if(a.mode==='selective_refraction') {
    if(g.selected){ctx.fillStyle='#7b8580';ctx.fillRect(slitX-3,cy-35,6,19);ctx.fillRect(slitX-3,cy-3,6,34);label(slitX,'窄缝');}
    if(a.prism2InPath)prism(secondX,cy-9,0);
    label(secondX,a.prism2InPath?'第二棱镜':'待放入');
  }
  if(a.mode==='recombination') {
    if(a.lensInPath){ctx.beginPath();ctx.ellipse(lensX,cy,6,h*.26,0,0,Math.PI*2);ctx.fillStyle='rgba(125,195,207,.42)';ctx.fill();ctx.strokeStyle='#508594';ctx.lineWidth=1.5;ctx.stroke();}
    label(lensX,a.lensInPath?'透镜':'待放入透镜');
    if(a.lensInPath){ctx.fillStyle='#ab8b53';ctx.fillText('会聚处',g.focusX,cy+h*.30);}
  }
  ctx.fillStyle='#fffdf7';ctx.fillRect(screenX,cy-h*.34,10,h*.68);ctx.strokeStyle='#958467';ctx.lineWidth=1.5;ctx.strokeRect(screenX,cy-h*.34,10,h*.68);
  if(result.lightOnScreen) {
    if(result.resultKind==='near_white_overlap') {ctx.fillStyle='#fff3d2';ctx.shadowColor='#edd890';ctx.shadowBlur=15;ctx.beginPath();ctx.ellipse(screenX+5,cy,10,10,0,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;}
    else g.rays.forEach(ray=>{const last=ray.points[ray.points.length-1];if(Math.abs(last.y-cy)<=h*.33){ctx.fillStyle=ray.color;ctx.fillRect(screenX+1,last.y-3,8,6);}});
    if(!a.prism1InPath){ctx.fillStyle='#f0dba0';ctx.fillRect(screenX+1,cy-4,8,8);}
  }
  label(Math.min(w-20,screenX+5),'白屏');
}
module.exports = { sceneGeometry, paintOpticsScene };
