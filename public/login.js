document.querySelector('#login').addEventListener('submit',async e=>{
  e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;
  try {
    const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Login failed');location.href='/';
  }catch(err){document.querySelector('#error').textContent=err.message;button.disabled=false}
});
