const field=document.getElementById('value');
window.promptAPI.onData(data=>{document.getElementById('label').textContent=data.message;field.value=data.value;field.focus();field.select();});
document.getElementById('form').onsubmit=event=>{event.preventDefault();window.promptAPI.answer(field.value);};
document.getElementById('cancel').onclick=()=>window.promptAPI.answer(null);
document.addEventListener('keydown',event=>{if(event.key==='Escape')window.promptAPI.answer(null);});
